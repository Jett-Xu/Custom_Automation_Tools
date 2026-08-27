# SPEC-10 — Agent Runtime（CLI 供應商適配）

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01（config、errors）、SPEC-06（路徑限制）、SPEC-09（attempt 記錄）
- **阻擋：** SPEC-11（編排）
- **取代：** 舊 SPEC-04 的 `Skill`／`SkillContext` 執行模型

---

## 1. 決策：agent 以子進程 CLI 執行

本專案**不自建 agent loop**。實作與驗證都委派給既有的 agent CLI
（Claude Code、Codex、Antigravity 等），以子進程呼叫。

**理由**
- 自建 loop 意味著自己實作工具定義、權限控管、context 管理、diff 套用、
  錯誤恢復 —— 每一項都是既有 CLI 已經做過且做得比較好的。
- 「插拔 AI」在此定義下變成「多一個 adapter」，而不是「多一套 agent 實作」。
- SPEC-02 的 `AiClient` 仍然保留，但**降級為輔助角色**：只用於便宜的結構化
  判斷（規劃、路由、摘要），不用於實作。兩條路徑職責分明。

**代價（必須接受）**
- token／成本可見度取決於各 CLI 是否輸出 usage。
- 各 CLI 的 flag、輸出格式、認證方式都不同，adapter 無法共用。
- 授權由各 CLI 自己的登入態管理，harness 不持有那些憑證。
- 版本升級可能改變輸出格式 → 需要 §6 FR-10-9 的契約測試。

寫入 ADR：`docs/adr/0007-agents-as-cli-subprocess.md`。

---

## 2. 目標／非目標

**目標**
- 一個 `AgentRunner` port，任何 agent CLI 都能在其後實作。
- 執行**絕不**卡在互動式提示；一定會結束或被殺掉。
- 每次執行有隔離的工作目錄，並行任務互不干擾。
- 結果以**結構化檔案**回收，不靠解析 stdout 散文。
- 每次執行有時間、輸出量、成本三重上限。

**非目標**
- 自建 tool-calling 迴圈。
- 遠端／容器化執行（v1 在本機跑；介面不排除日後換成容器 runner）。
- 對 agent 內部的工具權限做細粒度控管 —— 那是各 CLI 自己的設定，
  harness 只負責挑選預設安全的參數並限制工作目錄。

---

## 3. 目標設計

### 3.1 Port — `agents/ports.ts`

```ts
export interface AgentRunOptions {
  readonly taskId: string;
  readonly prompt: string;              // 任務描述（由 SPEC-11 組出）
  readonly systemPrompt?: string;       // playbook（見 §5）
  readonly cwd: string;                 // 隔離工作目錄，由呼叫端建立
  readonly role: "implement" | "verify";
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onEvent: (e: AgentEvent) => void;   // 串流進度 → SPEC-09 事件
}

export interface AgentRunResult {
  readonly status: "succeeded" | "failed" | "timeout" | "killed" | "stalled";
  readonly exitCode: number | null;
  /** agent 寫在 cwd/.harness/result.json 的結構化結果；缺檔為 null。 */
  readonly result: AgentResultFile | null;
  readonly usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly changedFiles: readonly string[];    // 相對 cwd，由 git status 取得
  readonly durationMs: number;
}

export interface AgentRunner {
  readonly id: string;                  // "claude-code" | "codex" | "antigravity" | …
  readonly displayName: string;
  /** 啟動時檢查：CLI 存在、版本可接受、已登入。失敗 throw AgentError。 */
  preflight(): Promise<void>;
  run(opts: AgentRunOptions): Promise<AgentRunResult>;
}
```

`AgentError extends AppError`，code 為 `AGENT_NOT_FOUND`、`AGENT_UNAUTHENTICATED`、
`AGENT_TIMEOUT`、`AGENT_STALLED`、`AGENT_BAD_OUTPUT`、`AGENT_CRASHED`。

### 3.2 結果契約 —— 不解析 stdout

每個 agent 被指示在結束前寫出 `cwd/.harness/result.json`：

```jsonc
{
  "ok": true,
  "summary": "新增 useDebounce hook 與單元測試",
  "changed": ["src/hooks/useDebounce.ts", "src/hooks/useDebounce.test.ts"],
  "notes": "測試以 vitest fake timers 撰寫",
  "blockers": []          // ok:false 時說明卡在哪
}
```

驗證角色另有 `verdict.json`：

```jsonc
{ "passed": false, "reasons": ["缺少 cleanup 的測試案例", "型別未匯出"] }
```

這段指示由 `AgentRunner` 附加在 prompt 尾端（各 adapter 用自己的措辭），
schema 以 zod 驗證。**缺檔或不合 schema → `AGENT_BAD_OUTPUT`**，該 attempt 記為
失敗。

理由：CLI 的散文輸出格式會隨版本改變，且無法穩定解析；一個約定的檔案是唯一
穩定的邊界。它也讓「換掉某個 CLI」不影響上游。

### 3.3 進程管理

實作於 `agents/process.ts`，所有 adapter 共用：

- `spawn(cmd, argv, { shell: false })` —— **絕不**用 `shell: true`。Windows 上
  引號規則會讓含空白或 `"` 的 prompt 靜默截斷或被當成多個參數。
- **Prompt 從 stdin 餵入**，不放在 argv。Windows 命令列長度上限約 32 KB，
  任務描述加 playbook 很容易超過；stdin 同時避開所有跳脫問題。
- **Idle watchdog** —— 若 `config.AGENT_IDLE_TIMEOUT_MS`（預設 `120_000`）內
  stdout／stderr 都沒有新輸出，視為卡在互動提示 → `stalled` → 殺掉。
  這是 headless 執行的**首要失敗模式**，必須有偵測。
- **總時限** —— `AgentRunOptions.timeoutMs` 到期 → 殺掉，記 `timeout`。
- **Windows 殺進程要殺整棵樹** —— `child.kill()` 在 win32 不會殺孫進程
  （CLI 常自己再開 node／git／tsc）。win32 用
  `taskkill /PID <pid> /T /F`，POSIX 用 `process.kill(-pgid)`（`detached: true`
  ＋ 送 `SIGTERM`，5 秒後 `SIGKILL`）。
- **輸出上限** —— stdout／stderr 各自寫檔並計數，超過
  `config.AGENT_MAX_OUTPUT_BYTES`（預設 `10_000_000`）→ 停止寫入、續讀以免
  管線阻塞、標記 `output_truncated`。
- **環境變數白名單** —— 子進程只繼承明確列出的變數（`PATH`、`HOME`／
  `USERPROFILE`、`APPDATA`、各 CLI 自己的認證變數）。**`GEMINI_API_KEY` 等本
  harness 的密鑰不傳給子進程。**

### 3.4 工作目錄隔離 —— git worktree

並行執行多個 agent 在同一個 repo 上會互相踩到。每個 attempt 取得自己的
worktree：

```
<projectRoot>/.harness-worktrees/<runId>/<taskId>-<n>/
```

- 由 `WorktreeManager`（`agents/worktree.ts`）建立：
  `git worktree add -b harness/<runId>/<taskId> <path> <baseRef>`。
- Attempt 結束後**不自動刪除** —— 保留供人工檢視與 SPEC-11 的整併。
  清理由保留策略（SPEC-09 FR-09-8）或 `npm run harness:clean` 執行。
- 目標 repo 不是 git repo → 退化為「複製到暫存目錄」模式，並在計畫核准時
  警告使用者無法自動整併。
- Worktree 路徑一律經 `confineWithin`（SPEC-06）驗證在 `PROJECT_ROOTS` 之下。

寫入 ADR：`docs/adr/0008-worktree-isolation.md`。

### 3.5 Adapter

每個 adapter 是一個檔案，**只有它知道那個 CLI 的參數與輸出格式**。

`agents/claude-code.ts`（參考實作）
- 非互動執行、輸出格式選用可機器解析的串流模式，逐行解析為 `AgentEvent`
  並取出 usage。
- 權限：使用預先設定的允許清單／非互動權限模式，**絕不**依賴互動核准。
- `preflight()`：確認執行檔存在、版本 ≥ 最低要求、已登入。

`agents/codex.ts`、`agents/antigravity.ts`
- 同樣的 port，不同的 argv 與解析。
- **這些 CLI 的非互動旗標、輸出格式與登入檢查方式必須在實作前逐一查證官方
  文件並記錄在 adapter 檔頂的註解。** 不得假設與 Claude Code 相同。
- 若某 CLI 無穩定的非互動模式 → 不納入 v1，在 ADR 註明。

`agents/registry.ts` —— 顯式列出（沿用 SPEC-00 P6）：

```ts
export const runners: readonly AgentRunner[] = [claudeCodeRunner, codexRunner, …];
export const runnerById = new Map(runners.map(r => [r.id, r]));
```

`config` 新增：
```
AGENT_IMPLEMENT=claude-code        # 預設實作 runner
AGENT_VERIFY=antigravity           # 預設驗證 runner
AGENT_ENABLED=claude-code,antigravity
AGENT_TIMEOUT_MS=900000
AGENT_IDLE_TIMEOUT_MS=120000
AGENT_MAX_OUTPUT_BYTES=10000000
AGENT_MAX_PARALLEL=2
```

### 3.6 驗證者的獨立性

`role: "verify"` 的執行必須滿足：
- **不同進程**（天然滿足）。
- **不同工作目錄視角** —— 驗證者拿到的是 worktree ＋ `git diff`，不繼承實作者
  的任何 context 或對話歷史。
- **預設不同 runner** —— `AGENT_VERIFY !== AGENT_IMPLEMENT` 時發出的是真正
  獨立的判斷；兩者相同時（例如都用 Claude CLI）仍是全新進程，但須在計畫
  回報中標示「同供應商驗證」，讓使用者知道獨立性較弱。
- **驗證者不得修改檔案** —— adapter 以唯讀模式／限制工具啟動；即使它改了，
  編排器在收下 verdict 後丟棄該 worktree 的變更（SPEC-11）。

---

## 3A. 威脅模型

### 3A.1 worktree 是組織隔離，不是安全邊界

**必須明確說出來的一句話：** 啟動一個 agent CLI 子進程，等於在自己的機器上
授權一個 AI 執行 shell 指令。

SPEC-06 把 harness 自己的 I/O 鎖得很緊 —— SSRF 防護、路徑限制、alias 制。
那些防護**完全不適用於 agent 子進程**。§3.4 的 worktree 給的是「兩個任務不會
互相踩到」，不是「agent 出不去」。agent 在 worktree 裡可以：

- `cd ..` 走出去，讀寫 `PROJECT_ROOTS` 以外的任何路徑
- 讀 `~/.ssh`、`~/.aws`、瀏覽器設定檔、其他專案的 `.env`
- 連任何外網位址，把讀到的東西送出去
- `git reset --hard`、`rm -rf`、修改 harness 自己的 `DATA_DIR` 與 `harness.db`
- 安裝套件、執行任意下載的程式

`cwd` 只是起始目錄，不是牢籠。

### 3A.2 防什麼／不防什麼

| 威脅 | 防不防 | 手段 |
|------|--------|------|
| 兩個並行任務互相覆蓋檔案 | **防** | worktree 隔離（FR-10-6） |
| agent 卡住／失控佔用機器 | **防** | idle watchdog ＋ 逾時 ＋ 殺樹（FR-10-3/4） |
| harness 的密鑰外流給子進程 | **防** | 環境變數白名單（FR-10-8） |
| 產物寫到不該寫的路徑 | **防** | `ArtifactWriter` 的 `confineWithin`（SPEC-09 §5） |
| 使用者訊息誘導 harness 讀主機檔案 | **防** | alias 制 workspace（SPEC-06） |
| 誤解需求後大規模亂改 | **防** | 強制人類核准關卡（SPEC-11 FR-11-3） |
| **agent 主動走出 worktree 改別的東西** | **不防** | 偵測，不預防（FR-10-15） |
| **agent 讀取主機憑證並外送** | **不防** | 信任決定（§3A.3） |
| **prompt injection：目標 repo 裡的檔案內容操縱 agent** | **不防** | 這是各 CLI 的問題，harness 無法介入 |
| **惡意的目標 repo** | **不防** | 前提是使用者對自己的 repo 有掌握 |

「不防」不代表沒風險，代表**這個風險由使用者承擔，且必須被明確告知**。
本 SPEC 的立場是：與其假裝有隔離，不如把邊界畫清楚。

### 3A.3 信任等級

`config.AGENT_TRUST_LEVEL`，三選一：

| 等級 | 含義 | v1 |
|------|------|-----|
| `full`（預設） | agent 取得該 CLI 的完整能力，只有 worktree 組織隔離。適用情境：自己的機器、自己的 repo、自己在旁邊 | ✅ 實作 |
| `restricted` | 逐 runner 顯式設定允許的工具清單、關閉網路類工具、環境變數白名單再收緊。能力下降，部分任務會做不完 | ✅ 實作 |
| `sandboxed` | 在容器／VM 內執行，`PROJECT_ROOTS` 以 bind mount 掛入 | ❌ v1 不做；`AgentRunner` port 不排除日後加一個實作 |

寫入 ADR：`docs/adr/0011-agent-trust-model.md`，內容須包含 §3A.1 的那句話、
§3A.2 的表、以及「為什麼 `full` 是合理的預設」。

### 3A.4 完整性偵測（不是預防）

每次 attempt 前後對 harness 自身與非目標路徑做輕量檢查：

- `harness.db` 的 size ＋ mtime；`DATA_DIR/runs/<runId>/` 的檔案數。
- 目標 repo 中 worktree **以外**的路徑（主工作區 `HEAD`、`.git/config`）。
- 該次 worktree 的 `git diff --stat`：刪除行數異常（> `ANOMALY_DELETE_LINES`，
  預設 `2000`）或觸及 `.git/`、`.env`、`node_modules/` 以外的預期外目錄。

任一異常 → 記 `security.anomaly` 事件（SPEC-09）＋ **在該 run 的最終報告中
以醒目方式警示** ＋ 該任務標記為 `needs_review`（不自動整併）。

這是**事後偵測**。它抓不到唯讀的外洩，也擋不住已經發生的破壞 —— 它的價值是
讓你在整併前看到「這次執行做了預期外的事」。不得把它描述成防護。

---

## 3B. 成本

### 3B.1 成本結構

agent 子進程是主要成本，`AiClient` 呼叫是次要。SPEC-08 FR-08-5 的
`MAX_AI_CALLS_PER_REQUEST=8` ／ `MAX_AI_CALLS_PER_DAY=500` 算的是**分流、規劃、
摘要**這些便宜的呼叫，**完全沒有涵蓋 agent 執行**。

最壞情況：12 個任務 × 2 次嘗試 × (實作 ＋ 驗證) ＝ **48 次 agent 執行**，
每次可能跑到 `AGENT_TIMEOUT_MS`（預設 15 分）。那是 12 小時的機器時間，
而預算閘一次都不會觸發。

### 3B.2 三層上限

| 層級 | 設定 | 預設 | 超過時 |
|------|------|------|--------|
| 單次執行 | `AGENT_TIMEOUT_MS` | `900_000` | 殺掉，標記 `timeout`，不重試 |
| 單個 run | `MAX_AGENT_RUNS_PER_RUN` | `30` | run 中止，`AppError("AGENT_BUDGET_EXCEEDED")`，已完成的任務保留 |
| 每日 | `MAX_AGENT_RUNS_PER_DAY` | `60` | 新的 engineering 需求直接拒絕，附今日用量 |
| 每日（時間） | `MAX_AGENT_MINUTES_PER_DAY` | `480` | 同上 |

每日計數 in-process ＋ 每日重置，並在啟動時從 Run Store 補回當日已用量
（避免重啟繞過額度）。

**牆鐘時間是唯一保證可得的成本代理指標。** `usage`（token／費用）是 optional ——
CLI 有吐就記，沒吐就只記時間。不得讓成本控管依賴一個 optional 欄位。

### 3B.3 核准前的成本預估

SPEC-11 §3.4 的計畫核准訊息必須包含預估，讓人在點頭前看得到代價：

```
📊 預估：4 個任務 → 最多 16 次 agent 執行、最長約 2 小時
   今日已用：12 / 60 次、95 / 480 分鐘
```

- 上界計算：`任務數 × MAX_ATTEMPTS_PER_TASK × 2`（實作＋驗證）。
- 預估超過當日剩餘額度 → 在計畫中警示，並說明可能中途中止。

---

## 4. 需求

### FR-10-1 — `AgentRunner` port
依 §3.1 定義。`AgentError` code 完整。至少兩個 adapter ＋ 一個
`FakeAgentRunner` 測試替身實作它。
**驗收：** `FakeAgentRunner` 在 60 行內實作完整 port 並被 SPEC-11 測試使用。

### FR-10-2 — 結構化結果契約
依 §3.2 以 zod 驗證 `result.json`／`verdict.json`。缺檔或不合 schema →
`AGENT_BAD_OUTPUT`。**不得**從 stdout 散文推斷成敗。
**驗收：** 測試：agent 寫出合法 `result.json` → `status: "succeeded"`；
寫出缺 `summary` 的檔 → `AGENT_BAD_OUTPUT`；完全沒寫 → `AGENT_BAD_OUTPUT`。
`grep -rn "stdout.includes\|stdout.match" src/agents/` 無結果（解析限於各
adapter 的串流事件，且僅用於進度與 usage）。

### FR-10-3 — 絕不阻塞於互動提示
Idle watchdog 依 §3.3 實作。所有 adapter 以非互動模式啟動，且 stdin 在餵完
prompt 後關閉。
**驗收：** 測試：fake CLI 印出一行後永久沉默 → 在 `AGENT_IDLE_TIMEOUT_MS` 後
回 `stalled` 且進程已被殺；fake CLI 讀 stdin 到 EOF 才結束 → 正常完成
（證明 stdin 有被關閉）。

### FR-10-4 — 進程樹確實被殺（含 Windows）
逾時、stall、`signal` abort 三種情況都殺掉整棵進程樹。
**驗收：** 測試（win32 條件式）：fake CLI 再開一個長命子進程 → 逾時後父子皆不
存在；POSIX 上以 process group 驗證同樣結果。

### FR-10-5 — Prompt 經 stdin、不用 shell
`spawn` 一律 `shell: false` ＋ argv 陣列；prompt 寫入 stdin。
**驗收：** `grep -rn "shell: true\|exec(" src/agents/` 無結果。測試：prompt 含
`" & | $ '` 與換行、長度 100 KB → agent 收到完整原文。

### FR-10-6 — 工作目錄隔離
每個 attempt 在自己的 git worktree 執行；路徑經 `confineWithin` 驗證；非 git
專案退化為複製模式並標記。
**驗收：** 測試：同一 run 的兩個並行 attempt 取得不同 `cwd`，各自的檔案修改
互不可見；`cwd` 逃出 `PROJECT_ROOTS` → `SecurityError`。

### FR-10-7 — 執行上限
`timeoutMs`、`AGENT_MAX_OUTPUT_BYTES`、`AGENT_MAX_PARALLEL` 全部生效。
輸出超量時停止寫檔但繼續讀取管線（避免死鎖）。
**驗收：** 測試：輸出 50 MB 的 fake CLI ＋ 上限 1 MB → 檔案 ≤ 1 MB、進程正常
結束、結果標記 `output_truncated`；`AGENT_MAX_PARALLEL=2` ＋ 5 個任務 →
同時存活的子進程數never > 2。

### FR-10-8 — 環境變數白名單
子進程只取得明確列出的變數。harness 自己的 API key 不外流。
**驗收：** 測試：fake CLI 印出 `process.env` → 輸出不含 `GEMINI_API_KEY`
且不含任何 config 中的密鑰值。

### FR-10-9 — `preflight()` 與 adapter 契約測試
每個 adapter 實作 `preflight()`（執行檔存在、版本、登入態），`main.ts` 對
`AGENT_ENABLED` 列出的每個 runner 啟動時執行；失敗 → fatal（SPEC-01 FR-01-6）
並點名是哪個 CLI、缺什麼。

另有一組**契約測試**（`npm run agent:contract`，不進 CI、需真實 CLI）：對每個
enabled runner 跑一個最小任務（「在 cwd 建立 hello.txt 並寫出 result.json」），
斷言 port 的每個回傳欄位都被正確填充。CLI 升級後靠這組測試發現輸出格式漂移。
**驗收：** 未安裝的 CLI → 啟動失敗且訊息含安裝指引；`agent:contract` 對每個
runner 通過。

### FR-10-10 — 驗證者獨立性
依 §3.6。`AGENT_VERIFY === AGENT_IMPLEMENT` 時，計畫回報須含警示字樣。
驗證者的檔案修改被丟棄。
**驗收：** 測試：verify 角色的 runner 修改了檔案 → 該修改不進入整併；
同 runner 設定 → 回報字串含「同供應商」。

### FR-10-11 — 每次執行都落地為 attempt
`run()` 的呼叫端（SPEC-11）在啟動前 `store.startAttempt()`、結束後
`store.finishAttempt()`，`onEvent` 轉成 SPEC-09 事件（節流）。stdout／stderr
路徑寫入 attempt 記錄。
**驗收：** 端到端測試：一次 fake agent 執行後，`getRun` 可讀到該 attempt 的
`exit_code`、`stdout_path`、`result_json`，且 `timeline` 含
`attempt.started`／`attempt.finished`。

### FR-10-13 — 威脅模型文件化
依 §3A 撰寫 ADR 0011，內容含 §3A.1 的核心陳述、§3A.2 的防／不防表、
預設等級的理由。README 的安全章節連到它。
**驗收：** ADR 存在且含上述三部分；README 有一段以使用者語言說明「這個工具
會在你的機器上執行 AI 產生的指令」。

### FR-10-14 — 權限設定顯式化，不吃 CLI 預設
每個 adapter 的權限相關參數（允許／拒絕的工具、非互動權限模式、是否允許網路）
一律由 `AGENT_TRUST_LEVEL` 與該 runner 的顯式設定決定，**不得**依賴 CLI 的
預設值 —— 預設值會隨版本改變。`AGENT_TRUST_LEVEL` 於啟動時記一筆 `info` log。
**驗收：** code review：每個 adapter 的 argv 組裝函式對權限參數都有顯式賦值；
測試：`restricted` 與 `full` 產生的 argv 不同且皆包含顯式權限旗標。

### FR-10-15 — 完整性偵測
依 §3A.4 實作 attempt 前後檢查。異常 → `security.anomaly` 事件 ＋ 任務標記
`needs_review` ＋ 最終報告醒目警示 ＋ **不自動整併**（SPEC-11 FR-11-9）。
**驗收：** 測試：fake agent 修改 worktree 以外的檔案 → `security.anomaly` 事件
存在、任務為 `needs_review`、該分支未被 merge、報告含警示；正常執行不產生
誤報。

### FR-10-16 — 核准訊息揭露信任等級
SPEC-11 §3.4 的計畫訊息必須標示：使用的 runner、`AGENT_TRUST_LEVEL`、
以及當 `AGENT_VERIFY === AGENT_IMPLEMENT` 時的「同供應商驗證」警示
（FR-10-10）。
**驗收：** 測試：`full` 等級的計畫訊息含信任等級字樣與 runner 名稱。

### FR-10-17 — agent 執行的三層上限
依 §3B.2 實作 `MAX_AGENT_RUNS_PER_RUN`、`MAX_AGENT_RUNS_PER_DAY`、
`MAX_AGENT_MINUTES_PER_DAY`。每日計數啟動時從 Run Store 補回當日已用量。
成本控管**不得**依賴 optional 的 `usage` 欄位。
**驗收：** 測試：`MAX_AGENT_RUNS_PER_RUN=3` → 第 4 次 `run()` 前 throw
`AGENT_BUDGET_EXCEEDED`，已完成任務保留；重啟後當日計數不歸零（從 store
的 `attempt` 表重算）；`MAX_AGENT_MINUTES_PER_DAY` 達標 → 新 engineering
需求被拒絕並附用量。

### FR-10-18 — 核准前的成本預估
依 §3B.3，計畫訊息含執行次數上界、時間上界、當日已用量。預估超過剩餘額度 →
警示。
**驗收：** 測試：4 個任務、`MAX_ATTEMPTS_PER_TASK=2` → 訊息含「最多 16 次」；
當日剩餘 5 次時 → 訊息含中途中止的警示。

### FR-10-19 — 用量可查詢
`npm run usage`（可選日期範圍）從 Run Store 統計：run 數、agent 執行次數、
總機器時間、有 `usage` 資料時的 token 與費用合計。
**驗收：** 對含 3 個 run 的 store 執行 → 輸出的執行次數與 `attempt` 表筆數
一致。

### FR-10-20 — 進程登記與 `killAll`
`agents/process.ts` 維護一份**活著的子進程清單**（pid、pgid、taskId、attemptId、
啟動時間），每次 spawn 登記、每次結束（正常或被殺）除名。對外提供：

```ts
export interface ProcessRegistry {
  readonly live: readonly LiveProcess[];
  /** 送 SIGTERM（win32 為 taskkill /T）給全部，等待至多 gracefulMs，殘留者 SIGKILL。 */
  killAllAndWait(gracefulMs?: number): Promise<void>;
  /** 立即硬殺，不等待。第二次 SIGINT 用。 */
  killAll(signal: "SIGKILL"): Promise<void>;
}
```

- `main.ts` 的關機序列（SPEC-03 §3.4）呼叫它作為**最後保險** —— 即使
  `Executor.stopAll()` 有漏網之魚，這裡也保證沒有孤兒。
- `/readyz`（SPEC-01 FR-01-7）**不因**有活著的子進程而變成 not-ready；
  但 `live.length` 應出現在 `/readyz` 的回應本體，方便觀察。
- 登記表是 in-process 的。進程被 `SIGKILL` 時無法執行清理 —— 這種情況下的孤兒
  由 SPEC-09 §7 的 `markInterrupted()` 在下次啟動時標記，並在 log 中提示使用者
  可能需要手動檢查 worktree。

**驗收：** 測試：spawn 3 個 fake CLI（各自再開一個孫進程）→ `killAllAndWait()`
→ 6 個進程全部消失、`live` 為空、方法在 `gracefulMs + 1s` 內 resolve；
測試：正常結束的子進程會自動除名（`live` 不會單調成長）；
測試（win32 條件式）：孫進程確實被 `taskkill /T` 收掉。

### NFR-10-1 — 加一個 CLI 供應商 = 一個檔案 ＋ 一行 registry ＋ 一組契約測試
**驗收：** README 記錄此流程；新增 adapter 不需修改 `agents/process.ts`、
`worktree.ts` 或 SPEC-11 的任何程式碼。

---

## 5. Playbook（原 15 個技能的去處）

舊 SPEC-04 的 15 個技能，其 `prompt.md` **是本專案真正的資產**，不隨 SPEC-04
一起刪除。它們降級為 **playbook**：

```
playbooks/
  architect/prompt.md
  test-strategy-advisor/prompt.md
  …
  registry.ts          # 顯式列出，含 id、title、description、適用階段
```

```ts
export interface Playbook {
  readonly id: string;
  readonly title: string;
  readonly description: string;          // 給 planner 挑選用
  readonly stage: "plan" | "implement" | "verify";
  readonly systemPrompt: string;         // 由 prompt.md 以 import.meta.url 讀入
}
```

- **`stage: "plan"` 的 playbook**（architect、spec-generator、sdd-generator、
  task-planner…）由 SPEC-11 的 planner 透過 `AiClient` 使用 —— 它們產文件，
  不需要工具。這條路徑與舊行為最接近。
- **`stage: "implement"` 的 playbook**（executor、ui-to-code、svg-to-component、
  test-case-writer…）作為 `AgentRunOptions.systemPrompt` 傳給 CLI。
- Playbook **沒有** `toArtifacts`、沒有 `outputSchema`、不做任何 I/O ——
  它就是一段 prompt 文字加 metadata。舊 SPEC-04 的 `Skill` 介面連同
  `saveFile.ts`、`skillLoader.ts`、Strategy 層一併刪除（舊 FR-04-7 仍然成立）。

**驗收（FR-10-12）：** 15 份 `prompt.md` 全數保留在 `playbooks/<id>/`；
`registry.ts` 顯式列出；`validateRegistry()` 檢查 id 唯一、`stage` 合法、
`systemPrompt` 非空；`find src -name 'SKILL.md'` 為空。

---

## 6. 順序

1. FR-10-1 port ＋ `FakeAgentRunner`。
2. FR-10-3/4/5 `agents/process.ts`（stdin、watchdog、殺樹、無 shell）—— 這是
   最容易出錯也最難事後補的部分，先做。
3. FR-10-2 結果契約 ＋ schema。
4. FR-10-6 `WorktreeManager`。
5. FR-10-7/8 上限與環境隔離。
6. 第一個 adapter（Claude Code）＋ FR-10-9 preflight ＋ 契約測試。
7. 第二個 adapter（驗證用）＋ FR-10-10。
8. §5 playbook 遷移。
9. FR-10-17 三層成本上限 —— **要在 SPEC-11 的 Executor 上線之前完成**，
   否則第一次跑滿 12 個任務就沒有煞車。
10. FR-10-13/14/16 威脅模型、權限顯式化、核准訊息揭露。
11. FR-10-15 完整性偵測 ＋ FR-10-18/19 成本預估與查詢。

### 新增設定項

```
AGENT_TRUST_LEVEL=full                 # full | restricted（sandboxed 為日後保留）
MAX_AGENT_RUNS_PER_RUN=30
MAX_AGENT_RUNS_PER_DAY=60
MAX_AGENT_MINUTES_PER_DAY=480
ANOMALY_DELETE_LINES=2000
```

---

## 7. 建議 ticket

1. `agents/ports.ts` ＋ `AgentError` ＋ `FakeAgentRunner`。*(FR-10-1)*
2. `agents/process.ts`：spawn／stdin／idle watchdog／殺進程樹／輸出上限 ＋ 測試
   （含 win32 條件式）。*(FR-10-3, FR-10-4, FR-10-5, FR-10-7)*
3. 結果契約 schema ＋ 驗證 ＋ prompt 尾綴注入。*(FR-10-2)*
4. `agents/worktree.ts` ＋ `confineWithin` 整合 ＋ 非 git 退化路徑 ＋ ADR 0008。*(FR-10-6)*
5. 環境變數白名單。*(FR-10-8)*
6. `agents/claude-code.ts` adapter ＋ `preflight` ＋ 串流解析 ＋ usage。*(FR-10-9)*
7. 第二個 adapter（查證該 CLI 的非互動旗標與輸出格式後實作）。*(FR-10-9)*
8. `npm run agent:contract` 契約測試 runner。*(FR-10-9)*
9. 驗證者獨立性規則 ＋ 修改丟棄 ＋ 同供應商警示。*(FR-10-10)*
10. `playbooks/` 遷移：15 份 prompt ＋ registry ＋ 驗證；刪除舊 skills 目錄結構。*(FR-10-12)*
11. ADR 0007（CLI 子進程決策）。*(§1)*
12. ADR 0011 威脅模型 ＋ README 安全章節。*(FR-10-13)*
13. 逐 runner 的權限參數顯式化 ＋ `AGENT_TRUST_LEVEL` 兩種等級。*(FR-10-14)*
14. 三層成本上限 ＋ 啟動時從 store 補回當日用量 ＋ 測試。*(FR-10-17)*
15. 核准訊息的成本預估與信任等級揭露。*(FR-10-16, FR-10-18)*
16. 完整性偵測 ＋ `security.anomaly` ＋ `needs_review` 串接。*(FR-10-15)*
17. `npm run usage` 統計 script。*(FR-10-19)*
