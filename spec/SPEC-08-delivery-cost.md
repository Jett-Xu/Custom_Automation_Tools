# SPEC-08 — 交付、成本與缺口收攏

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01 … SPEC-11（本份為橫切補充，非獨立階段）
- **對應的原始發現：** 無（本份收攏 SPEC-00…07 審閱後新發現的 15 點）
- **註：** 本份寫於 SPEC-04／05 刪除之前。凡提及 `Pipeline`／`Skill` 之處，請讀作 SPEC-11 的編排器與 SPEC-10 的 playbook；需求本身全部仍然成立。
- **阻擋：** 端到端可用性（§A、§B 未做則系統對使用者實際不可用）

---

## 1. 為什麼需要這份

SPEC-01…07 完整覆蓋了「內部結構與安全」，但有兩塊完全沒有負責人：

1. **交付** —— artifact 寫到本機磁碟後，使用者（在手機上）拿不到。
   `OutboundMessage.files` 在 SPEC-03 §3.1 被定義，但 00–07 沒有任何一條需求
   使用它。回覆長度上限（Telegram 4096 / Discord 2000）也無人處理，而本專案的
   技能產出的正是長篇設計文件 —— 這是**必定觸發**的失敗。
2. **成本與時限** —— 重構後每則訊息最多 1 次路由 ＋ 5 步 ＝ 6 次 LLM 呼叫，
   含 retry 上看 18 次。沒有 request 級 deadline、沒有輸出 token 上限、沒有預算
   閘。SPEC-02 §6 把計量列為「選配」。

另有 9 點是散落在各 spec 的正確性缺口與內部矛盾，一併在此收攏，避免它們變成
「實作到一半才發現」。

---

## 2. 目標／非目標

**目標**
- 產出真的送到使用者手上，且不因平台長度限制而失敗。
- 每個 request 有明確的時間上限與呼叫次數上限。
- Artifact 有明確的同名策略與保留策略。
- 補完 zod／Windows／重啟去重／prompt 回歸這四個會實際咬人的缺口。
- 修正各 spec 之間的內部矛盾。

**非目標**
- 多 agent 編排、任務拆解、驗證迴圈、執行軌跡持久化 —— 那是另一組 spec 的範圍
  （見 §7 備註）。
- 分散式 rate limiting／多實例（見 E-4）。
- 帳務系統。token 預算是**護欄**，不是計費。

---

## A. 交付

### FR-08-1 — 回覆長度切分與附件降級
`Gateway` 在送出前依 transport 宣告的上限處理回覆：

- `ChatTransport` 新增
  `readonly limits: { maxTextLength: number; maxFileBytes: number; supportsFiles: boolean }`
  （Telegram `4096`；Discord `2000`）。
- 回覆 ≤ `maxTextLength` → 原樣送出。
- 回覆 > `maxTextLength` 且 `supportsFiles` → 送出「摘要 ＋ 附件」：內文為
  `SkillResult.summary` 與 artifact 清單，長內容以 `OutboundMessage.files` 附上。
- 回覆 > `maxTextLength` 且不支援附件 → 依 `maxTextLength` 切成多則，切點優先
  落在換行，每則加 `(1/N)` 標記，總則數上限 3，超過改送截斷 ＋ 檔案路徑。
- 送出前對平台特殊字元轉義（Telegram `parse_mode` 遇未轉義 markdown 會 400）。
  預設不使用 `parse_mode`；若使用，轉義由 adapter 負責，不由 pipeline 負責。

**驗收：** 測試：8000 字回覆 ＋ `FakeTransport{maxTextLength:4096, supportsFiles:true}`
→ 一次 `send`，`text` ≤ 4096 且 `files.length === 1`；同樣輸入但
`supportsFiles:false` → 3 則以內、每則 ≤ 4096；含 `_*[]` 的回覆送 Telegram
adapter 不拋錯。

### FR-08-2 — Artifact 交付路徑閉環
`Pipeline.handle` 的回傳型別從 `string` 改為
`{ text: string; attachments: { name: string; content: Buffer }[] }`。
`ArtifactWriter.write` 回傳 `{ absPath: string; relPath: string; bytes: number }`。
Gateway 依 FR-08-1 決定 artifact 是內嵌、附件、或僅列路徑：

| 條件 | 交付方式 |
|------|----------|
| 單一 artifact 且 ≤ `maxTextLength` | 內文 |
| artifact 總量 ≤ `maxFileBytes` 且支援附件 | 附件 |
| 其餘 | 僅回覆 `relPath` 清單 ＋ 摘要 |

`relPath` 一律相對於 `DATA_DIR` 或 alias root，**絕不**回傳絕對路徑
（SPEC-06 FR-06-7）。

**驗收：** 端到端測試（SPEC-07 FR-07-3 延伸）：訊息進 → 磁碟有檔案 **且**
`FakeTransport` 收到帶 `files` 的 `OutboundMessage`，`text` 不含絕對路徑。

---

## B. 成本與時限

### FR-08-3 — Request 級 deadline
`Pipeline.handle` 接受 `AbortSignal`，由 Gateway 以
`config.REQUEST_TIMEOUT_MS`（預設 `120_000`）建立。逾時 → abort 進行中的 AI
呼叫、停止後續步驟、throw `AppError("REQUEST_TIMEOUT")`，經 boundary 轉成
使用者訊息。已完成步驟寫出的 artifact 保留，回覆須明說「已完成 N/M 步後逾時」。

**驗收：** 測試：3 步 pipeline，每步 fake AI 延遲 100ms，`REQUEST_TIMEOUT_MS=150`
→ `handle` reject `REQUEST_TIMEOUT`，`writer.write` 只被呼叫 1 次，AI 收到的
`signal.aborted === true`。

### FR-08-4 — 輸出 token 上限與截斷偵測
`config` 新增 `AI_MAX_OUTPUT_TOKENS`（預設 `8192`）。`GeminiClient` 傳給
`generationConfig.maxOutputTokens`，並檢查 `finishReason`：非
`STOP`（`MAX_TOKENS`、`SAFETY`、`RECITATION`）→
`throw new AiError(..., "AI_TRUNCATED" | "AI_BLOCKED")`。
截斷的內容**絕不**寫入磁碟、絕不回報成功。

**驗收：** 測試（stub SDK）：`finishReason: "MAX_TOKENS"` → `AI_TRUNCATED`，
`writer.write` 未被呼叫；`finishReason: "SAFETY"` → `AI_BLOCKED`。
`friendly()`（SPEC-06 §3.4）新增這兩個 code 的中文短語。

### FR-08-5 — 呼叫預算閘
把 SPEC-02 §6 的 usage 記錄從「選配」升為必要，並加上護欄：

- `AiClient` 以 decorator 包裝，每次呼叫記錄
  `{ correlationId, skillId, model, latencyMs, promptTokens, outputTokens }`。
- `config.MAX_AI_CALLS_PER_REQUEST`（預設 `8`，含 router 與 retry）。超過 →
  `AppError("BUDGET_EXCEEDED")`，pipeline 中止。
- `config.MAX_AI_CALLS_PER_DAY`（預設 `500`，in-process 計數 ＋ 每日重置）。
  超過 → gateway 直接回覆「今日額度已用盡」，不進 pipeline。
- 每個 request 結束時以 `info` 記一筆
  `{ event: "request.usage", calls, totalTokens, latencyMs }`。

**驗收：** 測試：`MAX_AI_CALLS_PER_REQUEST=3` 且 router ＋ 3 步 → 第 3 次技能
呼叫前 throw `BUDGET_EXCEEDED`；每日計數達上限 → pipeline 未被呼叫、回覆為
額度訊息。

---

## C. 產物生命週期

### FR-08-6 — 同名策略與保留策略
`ArtifactWriter` 的時間戳前綴代表無法「更新」既有文件，寫進 `PROJECT_ROOTS`
的真實 repo 會持續堆積。新增 `Artifact.writeMode`：

```ts
type WriteMode = "timestamped" | "overwrite" | "fail-if-exists";
```

- 預設 `"timestamped"`（寫入 `DATA_DIR` 時）。
- 帶 `projectAlias` 的 artifact 預設 `"fail-if-exists"` —— **絕不**靜默覆蓋
  真實專案裡的檔案；已存在 → `AppError("ARTIFACT_EXISTS")`，回覆告知使用者。
- `"overwrite"` 僅在技能顯式宣告時使用。
- `config.DATA_RETENTION_DAYS`（預設 `30`，`0` 為停用）：啟動時清掃
  `DATA_DIR` 下超齡的 artifact，記一筆 log。**只清 `DATA_DIR`，永不清
  `PROJECT_ROOTS`。**

**驗收：** 測試：`projectAlias` ＋ 目標已存在 → `ARTIFACT_EXISTS` 且檔案內容
未變；`DATA_RETENTION_DAYS=1` ＋ 一個 mtime 為兩天前的檔案 → 啟動後被刪，
`PROJECT_ROOTS` 下同齡檔案未被動。

---

## D. 正確性缺口

### FR-08-7 — 釘住 zod v4 並驗證供應商 schema 可轉換
- `package.json` 明確要求 `"zod": "^4"`。SPEC-01 用的 `z.prettifyError` 是 v4
  語意，裝到 v3 會靜默壞。
- 所有傳給 `AiClient.generateJson` 的 schema —— 主要是 SPEC-11 的
  `IntakeSchema` 與 `TaskPlanSchema`，以及 SPEC-10 的 `result.json`／
  `verdict.json` —— 需有明確的轉換實作：
  `z.toJSONSchema(schema, { target: "openapi-3.0" })`，再經一層
  `toProviderSchema()` 移除 Gemini `responseSchema` 不支援的構造
  （`$ref`、`additionalProperties`、`z.record`、巢狀 `anyOf`）。無法轉換 →
  在**啟動時**失敗，不是在使用者送訊息時。
- `main.ts` 啟動時對每一個會送出的 schema 執行一次 `toProviderSchema()`
  作為 smoke check。

**驗收：** 測試：含 `z.union([...])` 的 schema → 啟動時 throw
`AppError("SCHEMA_UNSUPPORTED")` 並點名是哪個 schema；現有全部 schema 通過。
`npm ls zod` 顯示 4.x。

### FR-08-8 — Windows 路徑正規化
`confineWithin`（SPEC-06 §3.3）在 win32 上以 `startsWith` 比對會因大小寫不敏感
的檔案系統誤判（`C:\Proj` vs `c:\proj`）。實作須：

```ts
const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};
```

比對用正規化值，回傳用原始 `path.resolve` 值。同樣規則套用到
`Workspace.scanTree` 的 symlink 逃逸檢查與 `PROJECT_ROOTS` alias 比對。

**驗收：** 測試（win32 條件式）：`base="C:\\Proj"`、`target="c:\\proj\\a.md"`
→ 通過且回傳保留原始大小寫；`target="C:\\Proj2\\a.md"` → `PATH_ESCAPE`。
POSIX 上大小寫敏感行為不變。

### FR-08-9 — 重啟後的去重
SPEC-03 FR-03-8 的 LRU 是 in-process，重啟即清空；Telegram 未被 confirm 的
update 會在重啟後重送，導致同一則訊息跑第二次（並花第二次的 token）。

擇一並記錄於 ADR：
- **（建議）持久化 seen-set** —— `DATA_DIR/.state/seen-updates.json`，
  只存最近 N 個 `${source}:${updateId}`，啟動載入、寫入時 debounce。
- **明確承認** —— 在 README 與 FR-03-8 註記「重啟期間的訊息可能重跑一次」，
  並確保重跑是冪等的（配合 FR-08-6 的 `fail-if-exists`）。

**驗收：** 選建議方案時：測試 —— 處理 updateId `X` → 重建 Gateway（模擬重啟）
→ 再送 `X` → pipeline 未被呼叫。

---

## E. 品質

### FR-08-10 — Prompt 回歸（golden）測試
SPEC-07 的技能 contract 測試保護的是 `toArtifacts`，**不保護 `prompt.md`**。
改壞 prompt 時全部測試依然綠燈，而 prompt 才是本專案的核心資產。

- 新增 `npm run eval` —— 不進 CI、需真實 API key、手動觸發。
- 每個 playbook `playbooks/<id>/eval.json`：1–3 組
  `{ input: string, assertions: string[] }`。
- Runner 對真實模型跑 prompt，以斷言檢查（結構性斷言優先：「輸出含
  `## API` 章節」、「JSON 通過對應 schema」；避免主觀語意斷言）。
- 輸出一份報告到 `data/eval/<timestamp>.md`，不做自動 pass/fail 閘。

**驗收：** `npm run eval -- --playbook architect` 對單一技能執行並產出報告；
CI 不執行此 script。

---

## F. 對既有 SPEC 的勘誤

以下為 SPEC-00／03／07 的**修正**，實作時以此為準。

### E-1 — ~~`no-match` 哨兵技能須豁免 tag 篩選~~ —— **已作廢**
此條原本修正 SPEC-05 的 router／channel-profile 設計。SPEC-05 已刪除，
其職責由 SPEC-11 的 Intake 分流取代 —— 「沒有適合的工具」變成
`kind: "chat"`／`"question"`，不再需要哨兵項目。**本條無須實作。**

### E-2 — 瑣碎訊息閘須為精確白名單（修正 SPEC-03）
SPEC-03 §3.2 步驟 3 的「已知問候語」比對，是關鍵字子字串比對，違反
SPEC-00 P6 的顯式原則。

修正：以**正規化後精確相等**比對一份短白名單（`trim().toLowerCase()` 後等於
`hi`／`hello`／`你好`／`在嗎` 等），**不得**使用 `includes`。空白訊息同樣走此閘。
**驗收：** 測試：`"hi"` → 罐頭回覆；`"hi, 幫我規劃架構"` → 進 pipeline。

### E-3 — 舊模組的刪除時機（修正 SPEC-00 §7）
原 SPEC-00 §7 聲稱每階段結束後服務仍可執行，但把「技能遷移」與「pipeline
替換」拆成兩階段，導致中間階段服務是壞的。

修正（已套用至 SPEC-00 §7 v2）：底盤階段（1–5）**不刪任何執行路徑上的舊模組**，
`saveFile.ts` 與 `orchestrator.ts` 一路保留到接手者就位：

| 刪除的模組 | 最早可刪的階段 | 接手者 |
|---|---|---|
| `OutputManager`、Strategy 層、`saveFile.ts` | 階段 6（SPEC-09） | `ArtifactWriter` |
| `skillLoader.ts`、`SKILL.md` | 階段 7（SPEC-10） | `playbooks/registry.ts` |
| `orchestrator.ts`、`CoreProcessor.ts` | 階段 8（SPEC-11） | Intake ＋ Executor |

**驗收：** 每個階段的 PR 合併後 `npm run start` 仍可啟動並處理一則訊息。

### E-4 — 單實例假設須成為 ADR（修正 SPEC-07 FR-07-8）
in-process LRU 去重、in-process per-user queue、無資料庫、無對話狀態、
in-process 每日配額（FR-08-5）—— 全部只在「單進程、單使用者」下成立。

修正：`docs/adr/` 新增第四份 `0004-single-instance-assumption.md`，明列上述
每一項依賴，以及要支援多實例時各自需要換成什麼（Redis／DB／外部佇列）。
**驗收：** 該 ADR 存在，且列出至少 5 項具名依賴。

---

## 3. 新增設定項

```
REQUEST_TIMEOUT_MS=120000
AI_MAX_OUTPUT_TOKENS=8192
MAX_AI_CALLS_PER_REQUEST=8
MAX_AI_CALLS_PER_DAY=500
DATA_RETENTION_DAYS=30
```

全數納入 SPEC-01 FR-01-4 的 zod schema 與 `.env.example`。

---

## 4. 優先序

| 級別 | 需求 | 理由 |
|------|------|------|
| **P0 — 不做則系統不可用** | FR-08-1、FR-08-2 | 長回覆必定觸發平台上限；產出送不到使用者手上 |
| **P0 — 不做則靜默產生垃圾** | FR-08-4 | 截斷的半份文件會被當成功寫入 |
| **P1 — 護欄** | FR-08-3、FR-08-5、FR-08-6 | 逾時、失控成本、覆蓋真實檔案 |
| **P1 — 實作會撞牆** | FR-08-7、FR-08-8 | zod 版本與 Windows 路徑，做 SPEC-06/09/11 時就會撞到 |
| **P2** | FR-08-9、FR-08-10 | 重啟去重、prompt 回歸 |
| **隨手** | E-1 … E-4 | 在對應 SPEC 實作時一併修正 |

---

## 5. 建議 ticket

1. `ChatTransport.limits` ＋ Gateway 長度切分／附件降級 ＋ 測試。*(FR-08-1)*
2. `Pipeline.handle` 回傳型別改為 `{text, attachments}`；`ArtifactWriter.write`
   回傳 metadata；交付決策表 ＋ 端到端測試。*(FR-08-2)*
3. `AI_MAX_OUTPUT_TOKENS` ＋ `finishReason` 檢查 ＋ `AI_TRUNCATED`／`AI_BLOCKED`
   ＋ `friendly()` 條目。*(FR-08-4)*
4. Request deadline ＋ `AbortSignal` 貫穿 pipeline → AI client。*(FR-08-3)*
5. Usage decorator ＋ per-request／per-day 預算閘 ＋ `request.usage` log。*(FR-08-5)*
6. `Artifact.writeMode` ＋ `fail-if-exists` 預設 ＋ 保留策略清掃。*(FR-08-6)*
7. 釘 zod v4；`toProviderSchema()` ＋ `validateRegistry()` 斷言。*(FR-08-7)*
8. `confineWithin` win32 正規化 ＋ 條件式測試。*(FR-08-8)*
9. 持久化 seen-set ＋ ADR。*(FR-08-9)*
10. `npm run eval` runner ＋ 每技能 `eval.json`。*(FR-08-10)*
11. 勘誤 E-1 … E-4（併入各自 SPEC 的 ticket）。

---

## 6. 追溯表 — 審閱發現 → 需求

| # | 發現 | 需求 |
|---|------|------|
| 1 | `toJsonSchema` 未定義，會撞 Gemini schema 子集 | FR-08-7 |
| 2 | zod 版本未釘（`prettifyError`／`ZodString` 為 v4） | FR-08-7 |
| 3 | 長輸出截斷被當成功 | FR-08-4 |
| 4 | 無整體 request timeout | FR-08-3 |
| 5 | 回覆長度上限未處理（必炸） | FR-08-1 |
| 6 | 交付路徑沒閉環，`files` 欄位無人使用 | FR-08-2 |
| 7 | 重啟後 LRU 去重失效 | FR-08-9 |
| 8 | Windows 上 `confineWithin` 誤判 | FR-08-8 |
| 9 | `no-match` 哨兵會被 tag 篩掉 | E-1（已作廢，SPEC-05 刪除） |
| 10 | 瑣碎訊息閘違反顯式原則（P6） | E-2 |
| 11 | Artifact 無同名／保留策略 | FR-08-6 |
| 12 | 成本無上限（計量僅列為選配） | FR-08-5 |
| 13 | 測試測不到 prompt 品質下降 | FR-08-10 |
| 14 | 遷移中間階段服務是壞的 | E-3 |
| 15 | 單實例假設未寫成 ADR | E-4 |

---

## 7. 備註 — 與 SPEC-09／10／11 的關係

本 SPEC 原寫於 SPEC-04／05 仍存在時，指出「若目標是多 agent harness，則需要
另一組 spec」。該組 spec 已補上：SPEC-09（執行軌跡與狀態儲存）、
SPEC-10（Agent Runtime）、SPEC-11（Plan／Execute／Verify 編排），SPEC-04／05
已刪除。

本份的每一條需求在新架構下**依然全部成立**，只是掛載點改變：

| 本份的需求 | 新架構中的落點 |
|---|---|
| FR-08-1／2（交付） | SPEC-11 §3.8 Reporter ＋ SPEC-03 Gateway |
| FR-08-3（deadline） | SPEC-11 FR-11-11（run 級）＋ SPEC-10 FR-10-7（attempt 級） |
| FR-08-4（截斷） | SPEC-02 的 `AiClient`（規劃／分流路徑） |
| FR-08-5（預算） | SPEC-11 FR-11-11 ＋ SPEC-09 的 `budget.*` 事件 |
| FR-08-6（產物生命週期） | SPEC-09 §5 `ArtifactWriter` |
| FR-08-7／8（zod／Windows） | SPEC-11 的 schema ＋ SPEC-06 的 `confineWithin` |
| FR-08-9（重啟去重） | SPEC-03 ＋ SPEC-09 §7 的 `markInterrupted()` |
| FR-08-10（prompt eval） | SPEC-10 §5 的 playbook |

新架構額外放大了其中兩條的重要性：agent 子進程的成本遠高於單次 LLM 呼叫，
因此 FR-08-5 的預算閘與 FR-08-3 的 deadline 從「護欄」升格為**必要條件**。
