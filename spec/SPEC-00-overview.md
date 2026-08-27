# SPEC-00 — 總覽、目標架構與遷移計畫

- **狀態：** 草稿
- **負責人：** 待定
- **相關文件：** VISION.md（目標）、SPEC-01 … SPEC-12（手段）

---

## 0. SPEC 集變更公告（v2）

目標系統的定義已擴大：從「聊天觸發的 LLM 技能路由器」改為
**多 agent 開發 harness** —— 訊息 → 需求分析 → 任務拆解 → 每任務一個 agent
執行 → 獨立 agent 驗證 → 可回溯的執行軌跡，且通訊軟體與 AI 供應商皆可插拔。

因此：

| 動作 | 內容 |
|------|------|
| **刪除** | SPEC-04（技能系統）、SPEC-05（路由與 Pipeline）—— 其執行模型（單次呼叫的純函式技能 ＋ 固定線性 chain）與目標不相容，屬重新設計而非補強 |
| **新增** | SPEC-09（執行軌跡與狀態儲存）、SPEC-10（Agent Runtime：CLI 子進程適配）、SPEC-11（Plan／Execute／Verify 編排） |
| **保留** | SPEC-01、02、03、06、07、08 —— 這些是底盤（設定、錯誤、傳輸、安全邊界、品質、交付與成本），與目標形狀無關且全部仍然需要 |
| **遷移** | 舊 SPEC-04 的 `ArtifactWriter` → SPEC-09 §5；舊 15 個技能的 `prompt.md` → SPEC-10 §5 的 **playbook**（prompt 內容全數保留） |

閱讀 SPEC-01／02／03／06／07 時，凡見到「SPEC-04」請讀作 SPEC-09（產物寫入）
或 SPEC-10（playbook／agent 執行）；凡見到「SPEC-05」請讀作 SPEC-11（編排）。
「Skill」一詞在舊文中指「prompt ＋ 純轉換函式」，新架構中對應 **Playbook**
（純 prompt ＋ metadata，無程式邏輯）。

---

## 1. 目的

這組 SPEC 定義了「聊天觸發的 LLM 任務路由器」的完整重構，寫法刻意設計成可以直接
拆成實作 ticket。每一份下游 SPEC 各自負責一條完整的工作線，內含編號需求
（`FR-xx-nn` / `NFR-xx-nn`），每條需求都自帶驗收標準，因此可對應到一到數張 ticket。

這是一次**重新架構，不是漸進式修補**。凡是現有程式碼與目標設計衝突之處，一律以
目標設計為準；舊模組直接刪除，不做相容性延伸。

---

## 2. 這個系統是什麼

完整的目標描述見 [VISION.md](./VISION.md)。摘要：

一個跑在本機的**個人開發 harness**，負責：

1. 從一個或多個聊天通道（Telegram、Discord、Line）接收文字訊息，
2. 驗證發送者身份，
3. 分流：閒聊／問答／產文件／工程任務 —— 大多數訊息止步於此，
4. 工程任務：把需求拆成任務 DAG，**送回聊天室等人核准**，
5. 核准後：每個任務在隔離的 git worktree 內派一個 **agent CLI 子進程**執行，
6. 每個任務由**另一個**獨立 agent 驗證；駁回則帶回饋重試，
7. 整併通過的分支、逐任務如實回報、把整段過程寫進可回查的執行軌跡。

通訊軟體與 AI 供應商都是插槽（見 §3 P8）。

---

## 3. 跨領域原則

| # | 原則 | 推論 |
|---|------|------|
| P1 | **Playbook 不做 I/O。** Playbook＝`prompt 文字 ＋ metadata`，沒有程式邏輯。 | 寫檔、選路徑、打網路全部在 playbook 之外。真正的工具使用發生在 agent 子進程內（SPEC-10），由 harness 以工作目錄與進程邊界限制。 |
| P2 | **不信任的輸入在邊界一次清洗完。** | 身份驗證、路徑限制、URL/SSRF 過濾都在 transport / platform 層。編排層永遠拿到乾淨資料。**注意：這條不適用於 agent 子進程**，見 SPEC-10 §3A。 |
| P3 | **失敗用型別表達並往上拋。** | 不允許哨兵字串（`"[AI Error]…"`）。單一最外層 boundary 把錯誤對應成 log 記錄 ＋ 給使用者的通用訊息。 |
| P4 | **設定集中、啟動即驗證。** | 只有一個模組讀 `process.env`。必填設定缺漏／格式錯誤時，服務在對外服務前就結束。 |
| P5 | **組裝只在一個地方發生。** | 所有 `new` 接線都在 `main.ts`。其他所有模組透過建構子或呼叫上下文取得依賴。 |
| P6 | **註冊是顯式的。** | 沒有目錄掃描魔法、沒有帶內插變數的 `import(\`…${var}…\`)`。技能與 transport 都在程式碼裡列出。 |
| P7 | **有第二個呼叫者才引入抽象，而不是預先做。** | 現有的 Strategy 層移除。多後端輸出等到真的有第二個後端時再回來。 |
| P8 | **不自建 agent loop。** 實作與驗證委派給既有 agent CLI 的子進程。 | 「插拔 AI」＝多一個 adapter，不是多一套 agent 實作。`AiClient`（SPEC-02）降級為輔助角色，只做便宜的結構化判斷（分流、規劃、摘要）。 |
| P9 | **動真實檔案前必須有人類關卡。** | `engineering` 類的計畫一律送聊天室核准後才執行（SPEC-11 FR-11-3），任何設定都不可跳過。 |
| P10 | **每個狀態變化都落地。** | 編排的每一步寫進 Run Store（SPEC-09）。log 給開發者看當下，Run Store 給使用者事後回查。 |

---

## 4. 目標模組佈局

```
src/
  main.ts                 # composition root：建 config、接線、啟動、處理 signal
  platform/
    config.ts             # 用 zod schema 包 process.env；解析失敗即結束
    logger.ts             # pino 實例 ＋ child logger helper
    errors.ts             # 型別化錯誤類別 ＋ isOperational()
    ai/
      client.ts           # AiClient 介面 ＋ AiError
      gemini.ts           # @google/genai 實作（唯一 import SDK 的檔案）
    artifacts.ts          # ArtifactWriter：唯一寫產出檔案的模組（SPEC-09 §5）
    safe-fetch.ts         # 唯一的對外 HTTP：SSRF 防護、timeout、body 上限
    workspace.ts          # 唯讀的專案樹掃描，限制在設定的 root 內
    store/
      run-store.ts        # RunStore：唯一碰資料庫的模組（SPEC-09）
      migrations/*.sql
  transport/
    ports.ts              # ChatTransport 介面、InboundMessage（唯讀）
    telegram.ts
    discord.ts
    line.ts               # 之後要加的第三個 transport
    gateway.ts            # 擁有 N 個 transport；allowlist；生命週期；去重；per-user queue
  agents/
    ports.ts              # AgentRunner 介面、AgentRunOptions、AgentRunResult（SPEC-10）
    process.ts            # spawn／stdin／idle watchdog／殺進程樹／輸出上限
    worktree.ts           # 每個 attempt 一個 git worktree
    registry.ts           # 顯式列出每一個 AgentRunner
    claude-code.ts        # adapter：只有它知道這個 CLI 的參數與輸出格式
    codex.ts
    antigravity.ts
  app/
    intake.ts             # 分流：chat / question / document / engineering（SPEC-11）
    planner.ts            # 產出 TaskPlan（DAG）＋ 驗證
    approval.ts           # 計畫渲染 ＋ 待核准狀態
    executor.ts           # 拓撲排序 ＋ 平行上限 ＋ 每任務一個 agent
    verifier.ts           # 獨立驗證 runner ＋ verdict 處理
    reporter.ts           # 整併 ＋ 逐任務狀態 ＋ 交付
  playbooks/
    registry.ts           # 顯式列出每一個 Playbook（SPEC-10 §5）
    <playbook-id>/
      prompt.md           # 純 prompt 文字，以 new URL(...) 讀入
```

重構完成時要刪除的舊模組：`src/agents/orchestrator.ts`、
`src/core/CoreProcessor.ts`、`src/core/io/OutputManager.ts`、
`src/core/strategies/*`、`src/core/io/input-parsers/PathExtractor.ts`、
`src/skills/skillLoader.ts`、`src/skills/*/saveFile.ts`、
`src/skills/*/SKILL.md`、`src/types/index.ts`、`WORKFLOW.md`、
`SKILLS-CONTENT.md`。

**保留並遷移**：15 份 `src/skills/*/SKILL.md` 的 prompt 本體 →
`src/playbooks/<id>/prompt.md`。這是本專案唯一不可重新產生的資產。

---

## 5. SPEC 索引

| SPEC | 標題 | 對應的原始發現 |
|------|------|----------------|
| SPEC-01 | 平台基礎（config、logging、errors、composition root、runtime/build） | 1, 11, 16, 17, 22, 25, 27 |
| SPEC-02 | AI Client | 2, 22, 24 |
| SPEC-03 | Transport 層與 Gateway | 3, 11, 14, 15, 19, 20 |
| ~~SPEC-04~~ | ~~技能系統與 Artifact 輸出~~ —— **已刪除**，見 §0 | 8, 9, 10, 12, 13 → SPEC-09／10 |
| ~~SPEC-05~~ | ~~路由與執行 Pipeline~~ —— **已刪除**，見 §0 | 2, 13, 20, 21 → SPEC-11 |
| SPEC-06 | 邊界安全 | 4, 5, 6, 7, 18 |
| SPEC-07 | 品質：測試、CI、文件、Repo 衛生 | 23, 25, 26, 27 |
| SPEC-08 | 交付、成本與缺口收攏 | 審閱新增 15 點 |
| SPEC-09 | 執行軌跡與狀態儲存（Run Store）＋ `ArtifactWriter` | 8, 9, 10（產物部分） |
| SPEC-10 | Agent Runtime（CLI 供應商適配）＋ Playbook | 12（prompt 載入）、新目標 |
| SPEC-11 | Plan／Execute／Verify 編排 | 2, 13, 20, 21、新目標 |
| SPEC-12 | Transport 擴充與長時 Run 的對話模型 | VISION 差距 1–3 |
| VISION | 目標描述（不編號，不隨 SPEC 改版） | — |

---

## 6. 追溯表 — 原始 27 點發現 → 需求

| # | 發現（簡述） | Spec | 需求 |
|---|--------------|------|------|
| 1 | build／生產路徑是壞的（`import` 帶 `.ts`、無 `start`、靜態檔沒複製） | SPEC-01 | FR-01-1, FR-01-2 |
| 2 | LLM 失敗被吞掉，還被當成結果存檔 | SPEC-02, SPEC-05 | FR-02-3, FR-05-6 |
| 3 | 對「誰能跟 bot 說話」沒有存取控制 | SPEC-03 | FR-03-3 |
| 4 | `PathExtractor` 把主機目錄樹洩漏給任何使用者 | SPEC-06 | FR-06-1, FR-06-2 |
| 5 | `web_summarizer` 的 `fetch()` — SSRF、無限制 | SPEC-06 | FR-06-4, FR-06-5 |
| 6 | `DesignatedOutput` 寫到任何 LLM 萃取出的路徑 | SPEC-06 | FR-06-6 |
| 7 | 原始 `error.message` 回傳到聊天室 | SPEC-06 | FR-06-7 |
| 8 | Strategy 層是死碼（16 個技能只有 1 個用） | SPEC-04 | FR-04-7 |
| 9 | 時間戳／寫檔區塊逐字複製約 13 份 | SPEC-04 | FR-04-6 |
| 10 | `SkillMetadata` 型別定義兩次 | SPEC-04 | FR-04-1, FR-04-2 |
| 11 | DI 半套（`new` 散落、服務自我實例化） | SPEC-01, SPEC-03 | FR-01-5, FR-03-6 |
| 12 | 脆弱的 regex frontmatter 解析 | SPEC-04 | FR-04-1, FR-04-3, FR-04-4 |
| 13 | 前端模式篩選因關鍵字碰撞而誤中 | SPEC-04, SPEC-05 | FR-04-5, FR-05-4 |
| 14 | `isFrontendDevMode` 寫死在 Telegram adapter | SPEC-03 | FR-03-7 |
| 15 | 沒有 graceful shutdown／生命週期 | SPEC-03 | FR-03-5 |
| 16 | 零 token 也會啟動；`/health` 沒意義 | SPEC-01 | FR-01-6, FR-01-7 |
| 17 | `env.ts` 不一致、無 fail-fast | SPEC-01 | FR-01-4 |
| 18 | `treeCache` 無上限、key 忽略 depth | SPEC-06 | FR-06-3 |
| 19 | 無並發／去重保護 | SPEC-03 | FR-03-8, FR-03-9 |
| 20 | `context.text` 就地被改寫 | SPEC-03, SPEC-05 | FR-03-10, FR-05-5 |
| 21 | Router 重試重送相同 prompt；regex 清洗 | SPEC-05 | FR-05-1, FR-05-2, FR-05-3 |
| 22 | 模型名稱寫死 | SPEC-01, SPEC-02 | FR-01-4, FR-02-2 |
| 23 | 零測試、無 lint／CI | SPEC-07 | FR-07-1 … FR-07-5 |
| 24 | 已 deprecated 的 `@google/generative-ai` SDK | SPEC-02 | FR-02-1 |
| 25 | `package.json` metadata 缺漏 | SPEC-01, SPEC-07 | FR-01-8, FR-07-7 |
| 26 | 文件漂移（WORKFLOW.md、README `npm start`、hot-reload 宣稱） | SPEC-07 | FR-07-6 |
| 27 | `.gitignore` 衛生、缺 `.editorconfig`／`.nvmrc`／prettier／eslint | SPEC-01, SPEC-07 | FR-01-9, FR-07-4, FR-07-7 |

---

## 7. 遷移順序（strangler）

分成兩大段：**底盤**（階段 1–5，結束時是一個安全、可測、可執行的服務，行為
與今天相近）與 **harness**（階段 6–10，長出 agent 編排能力）。

**底盤**

1. **SPEC-01** — 基礎。新的 `config`／`logger`／`errors`，`main.ts` 骨架先把
   *現有的* orchestrator 接在新 config 後面。鎖定 runtime/build 模式。
2. **SPEC-02** — AI client 換成 `@google/genai`，改成會 throw。
   **介面必須以 SPEC-10／11 的用途定案**（`generateJson` 是規劃與分流的主力），
   避免日後返工。
3. **SPEC-03** — `ChatTransport` port、`gateway`（auth ＋ 生命週期 ＋ 去重 ＋
   per-user queue）；adapter 縮回純傳輸。Line adapter 可在此或之後加。
4. **SPEC-06** — `workspace`（取代 `PathExtractor`）與 `safe-fetch`；路徑限制；
   對外錯誤淨化。
5. **SPEC-07 ＋ SPEC-08（P0/P1 部分）** — 測試骨架、CI、lint 規則；回覆長度與
   交付閉環；截斷偵測；deadline 與預算閘。

底盤完成時，舊 orchestrator 仍在跑但已被新的 config／錯誤／傳輸／安全層包住。
`ArtifactWriter` 在階段 6 才進來，因此階段 1–5 期間**暫時保留**現有的
`saveFile.ts`，不提前刪（避免舊 SPEC-04 那個「階段結束時服務是壞的」問題，
見 SPEC-08 E-3）。

**Harness**

6. **SPEC-09** — Run Store（SQLite ＋ migration ＋ 狀態機 ＋ 事件流）
   ＋ `ArtifactWriter` 遷入 ＋ `npm run trace`。**這是 10／11 的狀態基礎，
   必須先做。** 此階段結束時刪除 `OutputManager`、Strategy 層、`saveFile.ts`。
7. **SPEC-10** — `AgentRunner` port ＋ `process.ts`（stdin／watchdog／殺樹）
   ＋ `worktree.ts` ＋ 第一個 CLI adapter ＋ playbook 遷移。此階段結束時刪除
   `skillLoader.ts`、`SKILL.md`。
8. **SPEC-11** — Intake ＋ Planner ＋ **核准關卡** ＋ Executor ＋ Verifier
   ＋ Reporter。取代並刪除 `orchestrator.ts` ＋ `CoreProcessor.ts`。
   核准關卡要在 Executor 之前完成，不可先做「能跑」再補關卡。
9. **SPEC-12** — Transport port 擴充、雙車道佇列、待核准對話狀態、`Notifier`、
   webhook ＋ Line。**其中雙車道佇列與對話狀態必須早於階段 8 的 Executor 上線**，
   否則第一次跑長 run 就會把自己鎖住（見 SPEC-12 §7）。
10. **SPEC-08（P2）＋ SPEC-07 收尾** — 重啟去重、prompt eval、README 重寫、ADR。

依賴關係：02、03、06 依賴 01；09 依賴 01；10 依賴 01 ＋ 06 ＋ 09；
11 依賴 02 ＋ 09 ＋ 10；03 與 11 在核准關卡處整合（gateway 需要「待核准」狀態，
見 SPEC-11 §6）；07 與 08 橫跨全部。

---

## 8. 整個重構的完成定義（Definition of Done）

- [ ] 任何地方都沒有帶內插路徑的動態 `import()`。
- [ ] `grep -r "process.env" src/` 只出現在 `platform/config.ts`。
- [ ] `grep -rn "new .*Service\|new Orchestrator\|new .*Adapter" src/` 只出現在 `main.ts`。
- [ ] 沒有 `return "[... Error ...]"` 哨兵字串；所有失敗路徑都 `throw`。
- [ ] 每個 playbook 都是 `playbooks/registry.ts` 裡的顯式項目；沒有 `SKILL.md` frontmatter 解析。
- [ ] 產出檔案的寫入只發生在 `platform/artifacts.ts`，且每筆都登記進 Run Store。
- [ ] 對外 HTTP 只透過 `platform/safe-fetch.ts`。
- [ ] 目錄掃描只透過 `platform/workspace.ts`，且限制在設定的 root 內。
- [ ] 資料庫存取只發生在 `platform/store/`。
- [ ] `SIGINT`／`SIGTERM` 會乾淨關閉每個 transport、殺掉所有 agent 子進程、關閉 HTTP server。
- [ ] 新增一個通訊軟體 ＝ 一個 transport adapter ＋ 一行 registry。
- [ ] 新增一個 AI 供應商 ＝ 一個 agent adapter ＋ 一行 registry ＋ 一組契約測試。
- [ ] `app/` 底下不出現任何 CLI 名稱或 flag。
- [ ] 每個 agent 執行都在自己的 git worktree，且逾時／stall 一定會被殺掉整棵進程樹。
- [ ] `engineering` 類的 run 沒有核准就不會啟動任何 agent，且無法用設定跳過。
- [ ] 每個 run 都可用 `npm run trace <runId>` 完整重現：需求、計畫、每次嘗試、每個驗證結論、產物。
- [ ] 部分成功永遠如實回報，不存在把它講成完成的路徑。
- [ ] `git push` 不出現在 codebase 任何地方。
- [ ] `npm run check`（typecheck ＋ lint ＋ test）在每個 PR 的 CI 都通過。
- [ ] `WORKFLOW.md` 與 `SKILLS-CONTENT.md` 已刪除；README 與程式碼一致。
