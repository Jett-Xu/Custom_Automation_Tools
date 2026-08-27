# SPEC-11 — Plan / Execute / Verify 編排

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-02（`AiClient.generateJson`）、SPEC-09（Run Store）、SPEC-10（`AgentRunner`）
- **整合：** SPEC-03（gateway 呼叫）、SPEC-06（enrichment）、SPEC-08（交付與預算）
- **取代：** 舊 SPEC-05 的線性 `Router` ＋ `Pipeline`

---

## 1. 問題

舊 SPEC-05 的形狀是：`router` 挑 ≤5 個技能 → 依序各跑一次 LLM → 前一步的原始
字串塞進下一步的 prompt。這個形狀無法表達目標系統需要的四件事：

1. **任務是實體**，有標題、目標、驗收標準、依賴關係 —— 不是「技能 id」。
2. **任務可以平行**（無依賴時），也可以**單獨重試**（不必整條重跑）。
3. **驗證是獨立步驟**，不是實作 agent 自我宣告成功。
4. **中途失敗要有明確語意** —— 哪些任務完成了、哪些被略過、整併了沒有。

同時，把「拆出 N 個任務、每個都開一個 agent 改真實檔案」交給 LLM 自動決定，
**沒有人類確認關卡是不可接受的**。舊 SPEC-05 沒有這個關卡。

---

## 2. 目標／非目標

**目標**
- 五階段編排：Intake → Plan → Approve → Execute → Verify → Report。
- 任務以 DAG 表達，支援有上限的平行與拓撲排序。
- 每個任務由獨立 agent 執行、由**另一個**獨立 agent 驗證。
- 任務全過不等於需求被滿足 —— 另有一次 run 級驗收（FR-11-13）。
- 驗證駁回 → 帶回饋重試，有明確上限。
- 每個狀態變化都落進 Run Store（SPEC-09），全程可回查。

**非目標**
- Agent 內部行為（SPEC-10）。
- 資料持久化細節（SPEC-09）。
- 自動整併衝突的解決 —— 衝突時停下來交給使用者（§3.7）。
- 跨 run 的記憶／對話上下文。每個 run 獨立。

---

## 3. 目標設計

### 3.1 階段總覽

```
InboundMessage
   │
   ├─ Intake      分類 ＋ 解析 spec 參照                        ← AiClient（便宜）
   │              └─ Workspace.readFile → spec 快照           ← SPEC-06 FR-06-9
   │
   ├─ Plan        to-tickets：spec → TaskPlan（DAG）            ← AiClient
   │
   ├─ Approve     把計畫送到聊天室，等待使用者核准               ← 人類關卡
   │
   ├─ Execute     拓撲排序 → 每任務一個 AgentRunner            ← SPEC-10
   │     └─ Verify   每個成功的 attempt 交給驗證 runner
   │           └─ 駁回 → 帶 reasons 重試（上限 N）
   │
   ├─ RunVerify   對照 spec 快照驗收整體需求                    ← 獨立 runner
   │
   └─ Report      整併 → 匯總 → 回覆 ＋ trace 連結              ← SPEC-08 交付
```

### 3.2 Intake — `app/intake.ts`

不是每則訊息都值得拆任務。以一次便宜的 `generateJson` 分類：

```ts
const IntakeSchema = z.object({
  kind: z.enum(["chat", "question", "document", "engineering"]),
  targetAlias: z.string().nullable(),   // 使用者提到的 @alias（SPEC-06）
  specPath: z.string().nullable(),      // engineering 時的 spec 檔相對路徑
  scope: z.string().nullable(),         // 例如 "FR-09-1..FR-09-3"，null = 整份
  restated: z.string(),                 // 系統重述，供 chat/question/document 使用
});
```

| kind | 處理 |
|------|------|
| `chat` | 罐頭回覆，不建 run |
| `question` | 單次 `AiClient` 回答，建 run 但無 task |
| `document` | 走 plan-stage playbook 產文件，**不開 agent、不碰真實 repo** |
| `engineering` | 讀 spec → to-tickets → Approve → Execute → Verify 流程 |

**Intake 只看使用者這一則訊息做分類，不讀 spec 內容。** 它的工作是解析出
「要對哪個專案、做哪份 spec、做哪個範圍」。

#### `engineering` 的輸入形式

工程任務的輸入是**一份既有 spec 文件的參照**，不是一段自然語言需求：

```
@myapp 實作 spec/SPEC-09-run-store.md
@myapp 實作 spec/SPEC-09-run-store.md 的 FR-09-1 到 FR-09-3
```

理由：需求釐清（grill → spec）在 harness 之外、由人主導完成。harness 拿到的
是**已經被人想清楚並寫下來的東西**。這帶來三個結構性好處：

1. `acceptance` 直接來自 spec 中人類撰寫的「**驗收：**」條目，不是 LLM 發明的
   （見 §3.3）。
2. Run 級驗證（FR-11-13）比對的是真實文件，不是 LLM 自己生的理解。
3. 拆解的輸入是結構化文件而非模糊語句，是 LLM 做得最穩的那類任務。

**必要條件**（缺任一 → 回問，不猜測）：
- `targetAlias` 必須有值且存在於 `PROJECT_ROOTS`。
- `specPath` 必須有值。Intake **不接受**把 spec 內容直接貼在訊息裡 ——
  平台訊息長度上限（Telegram 4096）遠小於一份 spec。
- 讀取由 `Workspace.readFile(alias, specPath)`（SPEC-06 FR-06-9）執行。
  讀取失敗（找不到、太大、路徑逃逸）→ 回覆具體原因並終止，**不降級成
  「就用你那句話當需求」**。

**這個分流是成本控制的第一道閘** —— 大多數訊息不該走到 agent。

### 3.3 Plan — `app/planner.ts`（to-tickets）

Planner 的工作是**單一的**：把一份 spec 文件轉成任務 DAG。它不做需求釐清、
不重述需求、不發明驗收標準 —— 那些在 harness 之外已經完成。

```ts
const TaskPlanSchema = z.object({
  specSummary: z.string(),              // 一句話：這份 spec 在做什麼（僅供顯示）
  coverage: z.array(z.string()),        // 本計畫涵蓋的 FR 編號，供人核對有無遺漏
  tasks: z.array(z.object({
    key: z.string(),                    // 計畫內唯一，供 dependsOn 參照
    sourceRef: z.string(),              // 對應的 spec 條目，例如 "FR-09-3"
    title: z.string(),
    goal: z.string(),                   // 給實作 agent
    acceptance: z.array(z.string()).min(1),   // 見下方「驗收標準的來源」
    acceptanceVerbatim: z.boolean(),    // true = 逐字抄自 spec
    dependsOn: z.array(z.string()),
    playbook: z.string(),               // playbooks registry 的 id
    filesHint: z.array(z.string()),     // 預期涉及的檔案，供使用者判斷風險
  })).min(1).max(12),
  deferred: z.array(z.string()),        // 因範圍上限而未納入的 FR 編號
  risks: z.array(z.string()),
});
```

#### 驗收標準的來源 —— 這是本階段最重要的規則

`acceptance` **優先逐字抄自 spec 中該條目的「驗收：」內容**，並設
`acceptanceVerbatim: true`。只有在 spec 該條目確實沒有驗收敘述時，才允許
planner 自行撰寫，並設 `acceptanceVerbatim: false`。

核准訊息（§3.4）必須把 `acceptanceVerbatim: false` 的任務**標示出來** ——
那些是 LLM 猜的，是最需要你過目的部分。

理由：驗收標準的品質決定整個驗證環節的價值。人寫的、被 grill 逼問過的驗收
條件，遠強於 LLM 從任務描述反推出來的。這是把 spec 當輸入的主要收益。

#### 其他規則

- 由 `AiClient.generateJson` 產生。system prompt 含：spec 全文（或 `scope`
  圈定的段落）、可用 playbook 清單（id ＋ description）、目標專案的 workspace
  樹（SPEC-06 `enrich`）。
- **一個 FR 原則上對應一個 task。** 一個 FR 拆成多個 task 需要在 `risks` 說明
  理由；多個 FR 併成一個 task 則不允許 —— 那會讓驗收標準糊掉。
- **驗證 DAG**：`dependsOn` 只能參照計畫內存在的 `key`；不得有環（拓撲排序
  失敗 → 帶回饋重試一次）；`playbook` 必須存在於 registry；`sourceRef` 必須
  在 spec 中找得到。
- **範圍過大的處理**（`MAX_TASKS_PER_PLAN = 12`）：spec 的條目數超過上限時
  **不是失敗**。Planner 取前 N 個（依 spec 自身順序與 `dependsOn` 拓撲），
  其餘放進 `deferred`，核准訊息明確告知「本批做 1–12，其餘 5 條待下一批」。
  使用者也可用 `scope` 自行圈定（§3.2）。
- 若 spec 附有「建議 ticket」之類的章節，planner **應優先採用它的切分**，
  並在 `risks` 註明來源 —— 那是人已經想過的拆法。

#### Spec 快照

讀進來的 spec 內容與其 `sha256` 在建立 run 時就寫入 store
（SPEC-09 `run.spec_source` ／ `run.spec_sha256`）。之後的每一步 ——
規劃、核准顯示、執行、run 級驗證 —— 一律使用**快照**，不重讀磁碟。

理由：核准與執行之間可能相隔數十分鐘，spec 檔可能已被編輯。用快照可保證
「你核准的那份」就是「被實作的那份」，也是 FR-11-13 比對的那份。

### 3.4 Approve — 人類關卡

計畫產生後**一律**送到聊天室等待核准，格式：

```
📋 spec/SPEC-09-run-store.md (sha 3f8a1c…)
   涵蓋 FR-09-1 … FR-09-9、NFR-09-1 共 10 條 → 10 個任務

1. FR-09-1  Store schema 與 migration        [executor]  → src/platform/store/
2. FR-09-2  RunStore 唯一資料庫存取點        [executor]  (依賴 1)
3. FR-09-3  狀態機強制                       [executor]  (依賴 2)
...
9. FR-09-9  敏感資料不入庫                   [executor]  (依賴 2)  ⚠️ 驗收由 AI 補寫
10. NFR-09-1 寫入不阻塞編排                  [test-case-writer]  (依賴 2)

⏭️ 本批未納入：（無）
⚠️ 風險：<risks>
📊 預估：最多 40 次 agent 執行、約 5 小時
   今日已用：12 / 60 次、95 / 480 分鐘
🤖 實作：claude-code ／ 驗證：antigravity ／ 信任等級：full

回覆「執行」開始，「取消」放棄，或直接說要改什麼。
```

訊息中的固定元素：
- **spec 檔名 ＋ 快照 sha 前綴** —— 讓你確認它讀到的是你以為的那份。
- **每個任務標上 `sourceRef`** —— 讓你一眼看出有沒有漏掉哪條 FR。
- **`acceptanceVerbatim: false` 的任務標 `⚠️ 驗收由 AI 補寫`** —— 那是最需要
  你過目的地方（§3.3）。
- **`deferred` 清單**（本批未納入的條目）。
- 成本預估與信任等級（SPEC-10 FR-10-16／10-18）。

- 等待上限 `config.APPROVAL_TIMEOUT_MS`（預設 `1_800_000` ＝ 30 分鐘），
  逾時 → run 標記 `cancelled`。
- 使用者回覆修改意見 → 帶著意見重新 Plan（上限 3 次），不直接執行。
- `config.AUTO_APPROVE_KINDS` 可讓 `document` 類跳過關卡（預設跳過，因為它
  不碰真實 repo）；`engineering` **不可**設為自動核准 —— 這是硬規則，不是設定。

理由：這是唯一能阻止「LLM 誤解需求後在真實 repo 開 12 個 agent 亂改」的機制。
寫入 ADR：`docs/adr/0009-mandatory-plan-approval.md`。

### 3.5 Execute — `app/executor.ts`

```ts
class Executor {
  async run(runId: RunId, signal: AbortSignal): Promise<void>;
}
```

- 拓撲排序後分批；同批內以 `AGENT_MAX_PARALLEL` 為上限平行執行。
- 每個任務：
  1. `WorktreeManager` 建立隔離 cwd（SPEC-10 §3.4），base 為該 run 的共同基準
     commit。
  2. `store.startAttempt()` → `implementRunner.run({ role: "implement", … })`。
  3. 成功 → 進 Verify（§3.6）。失敗 → 依 §3.7 處理。
- **依賴的產出如何傳遞**：後續任務的 worktree 以「已通過驗證的前置任務分支」
  為 base 建立，而不是把前一步的字串塞進 prompt。prompt 只附上前置任務的
  `summary` 與 `changed` 清單作為上下文。**這是與舊 SPEC-05 最本質的差異** ——
  傳遞的是檔案狀態，不是文字。
- Run 級 deadline（SPEC-08 FR-08-3）與呼叫預算（FR-08-5）貫穿；abort 時
  殺掉所有進行中的 agent（SPEC-10 FR-10-4）。

### 3.6 Verify

每個成功的 attempt 交給驗證 runner：

- 輸入：任務 `goal`、`acceptance` 清單、`git diff`（該 worktree 對 base）、
  實作 agent 的 `result.json`。**不含**實作 agent 的對話歷史。
- 輸出：`verdict.json`（SPEC-10 §3.2）。
- `passed: true` → 任務 `passed`，分支保留供整併。
- `passed: false` → `store.recordVerdict()` → 重試（§3.7）。
- 驗證 runner 對檔案的任何修改被丟棄（SPEC-10 FR-10-10）。
- 驗證本身失敗（`AGENT_BAD_OUTPUT`／timeout）→ **不視為任務失敗**，重試驗證
  一次；再失敗 → 任務標記 `unverified`，在報告中明確標示「未經驗證」，
  **不宣稱成功**。

### 3.7 失敗處理

| 情況 | 行為 |
|------|------|
| 實作 agent 失敗（`failed`／`AGENT_BAD_OUTPUT`） | 重試，上限 `MAX_ATTEMPTS_PER_TASK`（預設 2）。第 2 次 prompt 附上第 1 次的 `blockers`／stderr 摘要 |
| 驗證駁回 | 重試，同一上限。prompt 附上 `verdict.reasons` 原文 |
| 逾時／stalled | 不重試（大機率會再逾時），任務標記 `failed` |
| 任務最終失敗 | 依賴它的下游任務標記 `skipped`；**無依賴關係的其他任務繼續執行** |
| 整併衝突 | 停止整併，run 標記 `needs_manual_merge`，回覆保留的 worktree 路徑清單 |

- 部分成功是**合法的終態**。報告必須逐任務標示 `passed`／`unverified`／
  `failed`／`skipped`，**絕不**把部分成功講成完成（沿用舊 SPEC-05 FR-05-6 精神）。

### 3.8 Report ＋ 整併

- 全部任務結束後，把通過驗證的分支依序 merge 回該 run 的整併分支
  `harness/<runId>/result`（**不動使用者的工作分支，不 push**）。
- 產生 `report.md`（SPEC-09 FR-09-6）。
- 回覆使用者：逐任務狀態、整併分支名稱、`npm run trace <runId>` 提示、
  產物清單。長度與附件依 SPEC-08 FR-08-1／FR-08-2 處理。

---

## 4. 需求

### FR-11-1 — Intake 分流與 spec 參照解析
依 §3.2 實作。`chat` 不建 run。`engineering` 必須解析出 `targetAlias` ＋
`specPath`（`scope` 選填）；缺任一 → 回問，不猜測。Intake **不讀 spec 內容**。
**驗收：** 測試：「早安」→ 罐頭回覆、`store` 無新 run；
「@myapp 實作 spec/SPEC-09.md」→ `kind: "engineering"`、`targetAlias: "myapp"`、
`specPath: "spec/SPEC-09.md"`、`scope: null`；加上「的 FR-09-1 到 FR-09-3」→
`scope` 有值；「@myapp 幫我加個 debounce hook」（無 specPath）→ 回問要哪份
spec、未進入 Plan；去掉 `@myapp` → 回問要哪個專案。

### FR-11-1b — Spec 讀取與快照
`engineering` 的 spec 以 `Workspace.readFile`（SPEC-06 FR-06-9）讀取。內容與
`sha256` 在建立 run 時寫入 `run.spec_source`／`run.spec_sha256`（SPEC-09）。
後續每一步一律使用快照，**不重讀磁碟**。讀取失敗 → 回覆具體原因並終止，
**不得**降級成「用使用者那句話當需求」。
**驗收：** 測試：spec 檔不存在 → 回覆點名該路徑、run 未建立或標記 `failed`、
未進入 Plan；讀取成功後在磁碟上改動該檔 → 核准訊息與 run 級驗證用的仍是原
內容；`getRun(id).specSha256` 與檔案內容的 sha256 相符。

### FR-11-2 — to-tickets：spec → TaskPlan
依 §3.3 實作。`sourceRef` 必須在 spec 快照中找得到；`dependsOn` 參照存在、
無環；`playbook` 存在；任務數 ≤ `MAX_TASKS_PER_PLAN`。違規 → 帶回饋重試一次
→ 仍違規則 run 失敗。
**驗收：** 測試：含環的計畫 → 第二次呼叫的 prompt 指出環的位置；未知 playbook
id → 重試 prompt 列出合法 id；`sourceRef: "FR-99-1"`（spec 中不存在）→ 重試
prompt 指出該編號無效。

### FR-11-2b — 驗收標準逐字取自 spec
Planner 對每個任務優先**逐字抄用** spec 中該 `sourceRef` 的驗收敘述並設
`acceptanceVerbatim: true`；spec 該條目確無驗收敘述時才自行撰寫並設 `false`。
核准訊息必須標示所有 `false` 的任務。
**驗收：** 以本 repo 的 `spec/SPEC-09-run-store.md` 為輸入的測試：FR-09-1…9
的任務其 `acceptance` 與 spec 中對應的「**驗收：**」內容逐字相符且
`acceptanceVerbatim: true`；人為移除某條的驗收敘述 → 該任務為 `false` 且核准
訊息含標示。

### FR-11-2c — 範圍過大時切批，不失敗
Spec 條目數超過 `MAX_TASKS_PER_PLAN` 時，取前 N 個（依 spec 順序與拓撲），
其餘進 `deferred`，核准訊息告知未納入的條目。**不得**因超量而讓 run 失敗。
使用者提供 `scope` 時只規劃該範圍。
**驗收：** 測試：18 條 FR 的 spec ＋ 上限 12 → 12 個任務 ＋ 6 個 `deferred`，
核准訊息列出後 6 條；`scope: "FR-09-1..FR-09-3"` → 恰好 3 個任務、
`deferred` 為空。

### FR-11-3 — 強制核准關卡
`engineering` 類的 run **必須**取得使用者核准才進入 Execute。無論任何設定都
不可跳過。逾時 → `cancelled`。修改意見 → 重新 Plan，上限 3 次。
**驗收：** 測試：核准前 `AgentRunner.run` 從未被呼叫；回覆「取消」→ run
`cancelled`、無 worktree 建立；`AUTO_APPROVE_KINDS=engineering` 的設定被
config 拒絕（非零結束）。

### FR-11-4 — 拓撲執行與有上限的平行
依 `dependsOn` 拓撲排序；同批平行上限 `AGENT_MAX_PARALLEL`；依賴未通過的任務
不啟動。
**驗收：** 測試（`FakeAgentRunner`）：A→B、A→C、D 獨立，`MAX_PARALLEL=2` →
執行順序為 {A, D} 然後 {B, C}；A 失敗 → B、C `skipped`、D 仍執行完成。

### FR-11-5 — 依賴以檔案狀態傳遞，非文字
後續任務的 worktree base 為已通過的前置任務分支。prompt 只附前置任務的
`summary` 與 `changed` 清單。
**驗收：** 測試：任務 A 建立 `foo.ts`；任務 B（依賴 A）的 cwd 中 `foo.ts`
存在；B 的 prompt 不含 `foo.ts` 的完整內容。

### FR-11-6 — 獨立驗證
每個成功的 attempt 都經過 `role: "verify"` 的獨立 runner；驗證輸入不含實作
agent 的對話歷史；驗證者的檔案修改被丟棄。驗證本身失敗 → `unverified`，
不宣稱成功。
**驗收：** 測試：實作 runner 回報 `ok: true` 但驗證 runner 回 `passed: false`
→ 任務進入重試而非完成；驗證 runner 連續兩次 `AGENT_BAD_OUTPUT` → 任務
`unverified`，最終回覆含「未經驗證」字樣。

### FR-11-7 — 帶回饋的重試
實作失敗與驗證駁回都重試至多 `MAX_ATTEMPTS_PER_TASK`（預設 2）次，第 2 次
prompt 必須包含上一次的具體失敗原因。逾時／stalled 不重試。
**驗收：** 測試：第 1 次驗證回 `reasons: ["缺少 cleanup 測試"]` → 第 2 次
implement 的 prompt 含該字串；第 1 次 `timeout` → 無第 2 次 attempt。

### FR-11-8 — 部分成功如實回報
最終回覆逐任務標示狀態，含 `passed` / `unverified` / `failed` / `skipped` 四種。
不存在把部分成功講成完成的路徑。
**驗收：** 測試：3 任務中 1 通過、1 失敗、1 略過 → 回覆三種狀態都出現，
且不含「全部完成」類字樣；`run.status` 為 `failed`（非 `done`）。

### FR-11-9 — 整併不動使用者分支
merge 目標為 `harness/<runId>/result`，永不 merge 進使用者當前分支、永不
`push`、永不 `--force`。衝突 → `needs_manual_merge` ＋ 回覆 worktree 路徑。
**驗收：** 測試：執行前後使用者的 `HEAD` 與工作區未變；製造衝突 → run 狀態
`needs_manual_merge`、回覆含分支名；`grep -rn "push\|--force" src/app/ src/agents/`
無結果（`git push` 完全不出現在 codebase）。

### FR-11-10 — 全程落進 Run Store
每個階段轉換、每次 attempt、每個 verdict、每個 artifact 都寫入 SPEC-09。
Run 結束時產生 `report.md`。
**驗收：** 端到端測試：一個 3 任務、含一次駁回重試的 run 完成後，
`timeline(runId)` 依序含 `run.created` → `run.plan_proposed` →
`run.plan_approved` → `task.started`×3 → `verify.rejected` →
`attempt.started`（第 2 次）→ `verify.passed` → `run.completed`。

### FR-11-11 — Deadline、預算與取消貫穿
SPEC-08 的 `REQUEST_TIMEOUT_MS`（run 級）與預算閘生效；使用者送「取消」→
abort 進行中的 agent（SPEC-10 FR-10-4）、run 標記 `cancelled`、保留已產生的
worktree。
**驗收：** 測試：run 逾時 → 所有子進程被殺、狀態 `timeout`、已完成任務保留；
執行中送「取消」→ 同樣行為、狀態 `cancelled`。

### FR-11-12 — 驗證前先跑專案自己的檢查指令
LLM 讀 diff 做判斷是**主觀訊號**；專案自己的 `npm run check`／`npm test`
是**客觀事實**。驗證階段必須先取得後者，再把結果當作輸入交給驗證 agent。

- 指令來源：`config.PROJECT_CHECKS`（`alias=npm run check` 形式）；未設定時
  自動偵測目標 `package.json` 的 scripts，依 `check` → `test` → 無 的順序。
- 在該任務的 worktree 內執行，套用 SPEC-10 §3.3 的同一套進程管理
  （無 shell、逾時、殺樹、輸出上限）。逾時上限 `CHECK_TIMEOUT_MS`（預設 `300_000`）。
- **非零結束 → 該 attempt 直接判定 `passed: false`**，`reasons` 為指令輸出的
  尾段；驗證 agent 仍會執行，但只用於補充說明，不能推翻失敗。
- 零結束 → 把「檢查通過」與輸出摘要放進驗證 agent 的輸入。
- 找不到檢查指令 → verdict 標記 `noAutomatedCheck: true`，最終報告中該任務
  註記「無自動檢查」。**不得**因為沒有檢查指令就當作通過。

**驗收：** 測試：check 指令 exit 1 → verdict `passed: false` 且 `reasons` 含
輸出尾段，即使驗證 agent 回傳 `passed: true`；check 指令 exit 0 → 驗證 agent
的輸入含「檢查通過」；目標專案無 `check`／`test` script → verdict 帶
`noAutomatedCheck`、報告含「無自動檢查」字樣；check 逾時 → 視同失敗並殺掉
進程樹。

### FR-11-13 — Run 級驗證：任務全過 ≠ 需求被滿足
每個任務只對照**自己的** `acceptance` 被驗證。沒有任何一步回頭確認「這些任務
加起來真的滿足了原始需求」。失敗模式：planner 漏拆一個任務 → 其餘全部
`passed` → 報告宣稱通過 → 使用者拿到做了一半的功能。這與 FR-11-8 是同一類
問題，只是換了層次。

Report 階段之前，執行一次 run 級驗證：

- 輸入：**spec 快照原文**（`run.spec_source`，若有 `scope` 則為該範圍段落）、
  全部任務的 `sourceRef` ＋ `acceptance` ＋ 最終狀態、整併分支對 base 的
  `git diff --stat` 與各任務的 `summary`。**不含**任何實作 agent 的對話歷史。
- 問題是明確的：**「這份 spec 的每一條，都被實作了嗎？」** 有 `deferred` 時，
  那些條目不計入 —— 它們是刻意留到下一批的，不是 gap。
- 由 `role: "verify"` 的 runner 執行，輸出 `run-verdict.json`：
  `{ satisfied: boolean, gaps: string[], notes: string }`。
- **這一步不阻擋整併** —— 通過驗證的任務分支照樣合併。它的產出是**報告內容**：
  - `satisfied: true` → 報告標示「需求已滿足」。
  - `satisfied: false` → 報告以醒目方式列出 `gaps`，run 狀態為 `done_with_gaps`
    （新的終態，**不是** `done`）。
  - 驗證本身失敗／逾時 → 標示「需求層級未經驗證」，不重試，不宣稱滿足。
- 計入 agent 執行預算（SPEC-10 FR-10-17），每個 run 恰好一次。
- 全部任務都 `failed`／`skipped` 時跳過此步（沒有東西可驗）。

**驗收：** 測試：3 個任務全部 `passed` 但 run 驗證回 `satisfied: false,
gaps: ["FR-09-8 的保留策略未實作"]` → run 狀態 `done_with_gaps`、報告含該 gap
原文、整併仍然發生；測試：run 驗證逾時 → 報告含「需求層級未經驗證」且未重試；
測試：傳給驗證者的是 `run.spec_source` 快照（不是重讀磁碟、也不是 LLM 重新
生成的理解）；測試：有 `deferred` 條目時，驗證者的輸入不含那些條目，且它們
不出現在 `gaps` 中。

### NFR-11-1 — 編排器不含供應商知識
`app/` 底下不出現任何 CLI 名稱、flag、或輸出格式假設；一律透過
`AgentRunner` port。
**驗收：** `grep -rin "claude\|codex\|antigravity\|--print\|-p " src/app/` 無結果
（設定值的字串比對除外）。

---

## 5. 新增設定項

```
APPROVAL_TIMEOUT_MS=1800000
MAX_ATTEMPTS_PER_TASK=2
MAX_PLAN_REVISIONS=3
MAX_TASKS_PER_PLAN=12
CHECK_TIMEOUT_MS=300000
PROJECT_CHECKS=                       # alias=npm run check，逗號分隔；留空則自動偵測
AUTO_APPROVE_KINDS=document          # engineering 不可列入，config 會拒絕
```

---

## 6. 順序

1. FR-11-1 Intake（純函式 ＋ 一次 `generateJson`，可獨立測試）。
2. FR-11-2 Planner ＋ DAG 驗證（不接 agent，先用 `FakeAgentRunner`）。
3. FR-11-3 核准關卡 ＋ gateway 的待回覆狀態。**這個要在 Execute 之前做完。**
4. FR-11-4/5 Executor ＋ worktree base 鏈。
5. FR-11-12 專案檢查指令執行（先於驗證 agent，是它的輸入）。
6. FR-11-6/7 Verify ＋ 重試。
6. FR-11-8/9 報告 ＋ 整併。
7. FR-11-10/11 Store 整合、deadline、取消。

**Gateway 需要新增「等待核准」狀態** —— 使用者的下一則訊息可能是核准、
修改意見、或全新需求。這改變了 SPEC-03 的 per-user queue 語意，需一併處理：
待核准的 run 佔用該使用者的 slot，新需求進來時提示「你有一個計畫待確認」。

---

## 7. 建議 ticket

1. `app/intake.ts` ＋ 分流 ＋ 測試。*(FR-11-1)*
2. `app/planner.ts` ＋ `TaskPlanSchema` ＋ DAG 驗證 ＋ 帶回饋重試 ＋ 測試。*(FR-11-2)*
3. 核准關卡：計畫渲染、gateway 待回覆狀態、逾時、修改重規劃 ＋ ADR 0009。*(FR-11-3)*
4. `app/executor.ts`：拓撲排序、平行上限、worktree base 鏈 ＋ 測試。*(FR-11-4, FR-11-5)*
5. 專案檢查指令執行器（沿用 SPEC-10 進程管理）＋ 自動偵測 ＋ 測試。*(FR-11-12)*
6. Verify 階段 ＋ verdict 處理 ＋ `unverified` 語意 ＋ 測試。*(FR-11-6)*
6. 重試策略 ＋ 回饋注入 ＋ 測試。*(FR-11-7)*
7. Run 級驗證 ＋ `done_with_gaps` 終態 ＋ 測試。*(FR-11-13)*
8. 整併（merge 到 `harness/<runId>/result`）＋ 衝突處理 ＋ 測試。*(FR-11-9)*
8. 報告渲染 ＋ 逐任務狀態 ＋ SPEC-08 交付整合。*(FR-11-8)*
9. Store 整合、run deadline、取消指令 ＋ 端到端測試。*(FR-11-10, FR-11-11)*
10. 刪除舊 `orchestrator.ts` ＋ `CoreProcessor.ts`；`main.ts` 接線。*(清理)*
