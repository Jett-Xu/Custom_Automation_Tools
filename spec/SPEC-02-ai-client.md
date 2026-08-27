# SPEC-02 — AI Client

> **v2 勘誤：** SPEC-04／05 已刪除，由 SPEC-09（Run Store ＋ ArtifactWriter）、
SPEC-10（Agent Runtime ＋ Playbook）、SPEC-11（Plan／Execute／Verify 編排）取代。
本文中的「SPEC-04」請讀作 SPEC-09／10，「SPEC-05」請讀作 SPEC-11，
「Skill」請讀作 Playbook。詳見 SPEC-00 §0。

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** SPEC-01（config、errors、logger）
- **對應的原始發現：** 2, 22, 24
- **阻擋：** SPEC-04、SPEC-05

---

## 1. 問題

- `src/services/ai/gemini.ts` 使用 `@google/generative-ai`，Google 已將其
  deprecated，改推 `@google/genai`。
- `ask()` 捕捉所有錯誤後回傳字串 `"[AI Error]: …"`。呼叫端無法分辨真正的答案與
  失敗；router 用 regex 解析它，pipeline 把它存進檔案。
- 模型名稱寫死。沒有 timeout、沒有 retry、路由也沒有 structured-output 路徑。
- 這個服務在 `main` 與 `web_summarizer/saveFile.ts` 裡都被 `new`。

---

## 2. 目標／非目標

**目標**
- 一個與供應商無關的 `AiClient` 介面；一個 Gemini 實作被隔離在它後面。
- 錯誤以 `AiError` 傳播。
- Timeout ＋ 有上限的 retry（含 backoff）。
- 為路由與需要 JSON 的技能提供一級的 structured-output 呼叫。
- 啟動時的憑證檢查，餵給 `/readyz`。

**非目標**
- 現在就支援多供應商（介面不得*阻止*它，但只實作 Gemini）。
- 串流回應（此工作負載不需要）。
- Token 計量／成本追蹤（選配，見 §6）。

---

## 3. 目標設計

### 3.1 介面 — `platform/ai/client.ts`

```ts
export interface GenerateOptions {
  system: string;
  prompt: string;
  correlationId: string;
  signal?: AbortSignal;
}

export interface GenerateJsonOptions<T> extends GenerateOptions {
  schema: z.ZodType<T>;                 // parse 後再驗證
  jsonSchema: Record<string, unknown>;  // 供應商的 responseSchema
}

export interface AiClient {
  /** 自由文字補全。transport／模型失敗時 throw AiError。 */
  generate(opts: GenerateOptions): Promise<string>;

  /** 結構化補全。失敗或 schema 不符時 throw AiError。 */
  generateJson<T>(opts: GenerateJsonOptions<T>): Promise<T>;

  /** 啟動時用來驗證 API key 的廉價呼叫。throw AiError。 */
  healthCheck(): Promise<void>;
}
```

### 3.2 實作 — `platform/ai/gemini.ts`

- 唯一 import `@google/genai` 的檔案。
- 建構子接受 `{ apiKey, model, timeoutMs, maxRetries, logger }` —— 全部來自
  `config`。
- 每次呼叫：
  - 用帶 `timeoutMs` 的 `AbortController` 包住（與呼叫端 `signal` 合併）。
  - 對暫時性失敗（HTTP 429/500/503、網路錯誤、timeout）用指數 backoff ＋ jitter
    重試，最多 `maxRetries` 次。**不要**對 4xx auth/validation 錯誤重試。
  - 最終失敗 → `throw new AiError(msg, code)`，`code` 為
    `AI_TIMEOUT`、`AI_RATE_LIMIT`、`AI_AUTH`、`AI_UPSTREAM`、`AI_EMPTY`、
    `AI_SCHEMA` 其中之一。
  - 空／被封鎖的回應 → `AiError("empty response", "AI_EMPTY")`。
- `generateJson`：
  - 傳 `responseMimeType: "application/json"` ＋ `responseSchema: jsonSchema`。
  - `JSON.parse` 然後 `schema.parse`；任一失敗 → `AiError(…, "AI_SCHEMA")`，
    原始文字附在 log（不附在 thrown 的訊息裡）。
- 每次呼叫以 `debug` 記 log（model、latency、嘗試次數、prompt/response 長度 ——
  絕不在 `info` 以上記完整內容）。

### 3.3 接線

- 在 `main.ts` 建一次，注入 `Router` 與每個技能（透過 `SkillContext.ai`，
  SPEC-04）。任何技能都不自建 client。
- `main.ts` 在啟動時 `await ai.healthCheck()`；失敗 → fatal（FR-01-6），或若你
  偏好降級啟動，`/readyz` 維持 503 直到後續檢查通過。預設：**fatal**。

---

## 4. 需求

### FR-02-1 — 遷移到 `@google/genai`
把 `@google/generative-ai` 換成 `@google/genai`。從 `package.json` 與 lockfile
移除舊依賴。SDK 只在一個檔案 import。
**驗收：** `grep -rn "@google/generative-ai" .` 在 lockfile 歷史以外無結果；
`grep -rln "@google/genai" src/` 只回 `platform/ai/gemini.ts`。

### FR-02-2 — 模型與呼叫參數來自 config
`model`、`timeoutMs`、`maxRetries` 來自 `Config`（SPEC-01 FR-01-4）。程式碼裡沒有
字面模型字串。
**驗收：** `grep -rn "gemini-" src/` 在 `platform/config.ts` 預設值與測試以外
無結果。

### FR-02-3 — 錯誤以 `AiError` 傳播
`generate`／`generateJson` 絕不回傳哨兵字串。每個失敗路徑都 throw `AiError`，
帶已定義的 `code` 之一。
**驗收：** 以 stub SDK 做單元測試：timeout → `AI_TIMEOUT`；429 → 重試後
`AI_RATE_LIMIT`；401 → `AI_AUTH` 且不重試；空 candidates → `AI_EMPTY`。沒有任何
測試觀察到 `"[AI Error]"` 字串。

### FR-02-4 — Timeout ＋ 有上限的 retry（含 backoff）
每次呼叫受 `timeoutMs` 限制。暫時性失敗重試最多 `maxRetries` 次（指數 backoff
＋ jitter）；非暫時性失敗不重試。
**驗收：** 測試斷言嘗試次數：`maxRetries=3` 時 503×3 後成功 → resolve；一直 503
→ 恰好 `maxRetries+1` 次嘗試後 reject；400 → 恰好 1 次嘗試。

### FR-02-5 — `healthCheck()` 供 readiness 使用
實作一個驗證 API key 的最小呼叫。`main.ts` 在啟動時執行；結果 gate `/readyz`
（SPEC-01 FR-01-7）。
**驗收：** 整合測試：無效 key → `healthCheck` throw `AI_AUTH`；`main` 視為 fatal
（或依所選政策 `/readyz` 回 503）。

### FR-02-6 — `generateJson` 含 schema 驗證
Structured-output 呼叫傳供應商 `responseSchema`，並以 zod schema 驗證結果；
不符 → `AiError("…","AI_SCHEMA")`。
**驗收：** 測試：模型回傳格式錯誤的 JSON → `AI_SCHEMA`；回傳違反 zod schema 的
JSON → `AI_SCHEMA`；合法 → 回傳型別化值。

### NFR-02-1 — `debug` 以上不記內容
Prompt 與 response 的*本體*絕不在 `info` 或以上記 log。長度與 metadata 可以。
**驗收：** code review；grep `gemini.ts` 的 logger 呼叫。

---

## 5. 順序

1. FR-02-1（換 SDK）＋ FR-02-2（參數）—— 機械性，先做。
2. FR-02-3 ＋ FR-02-4（錯誤 ＋ retry 核心）。
3. FR-02-6（`generateJson`）—— SPEC-05 router 之前要有。
4. FR-02-5（`healthCheck`）—— 需要 SPEC-01 `/readyz`。

---

## 6. 選配／之後

- 一個 `AiClient` decorator，把 `{ skillId, model, latency, usage }` 記到
  logger 或 metrics sink。讓「token 消耗」的說法變成資料驅動，而不是寫死在文件
  （SPEC-07 FR-07-6）。

---

## 7. 建議 ticket

1. 換 SDK 到 `@google/genai`；隔離在 `platform/ai/gemini.ts`；參數來自 config。*(FR-02-1, FR-02-2)*
2. 定義 `AiClient` 介面 ＋ `AiError` code。*(FR-02-3)*
3. 實作 timeout ＋ retry/backoff wrapper ＋ 測試。*(FR-02-4)*
4. 實作 `generateJson`（responseSchema ＋ zod 驗證）＋ 測試。*(FR-02-6)*
5. 實作 `healthCheck()`；接進 `main` 啟動流程與 `/readyz`。*(FR-02-5)*
6. （選配）usage 記錄 decorator。*(§6)*
