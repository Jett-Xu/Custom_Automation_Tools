# SPEC-01 — 平台基礎

> **v2 勘誤：** SPEC-04／05 已刪除，由 SPEC-09（Run Store ＋ ArtifactWriter）、
SPEC-10（Agent Runtime ＋ Playbook）、SPEC-11（Plan／Execute／Verify 編排）取代。
本文中的「SPEC-04」請讀作 SPEC-09／10，「SPEC-05」請讀作 SPEC-11，
「Skill」請讀作 Playbook。詳見 SPEC-00 §0。

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** 無（第一階段）
- **對應的原始發現：** 1, 11, 16, 17, 22, 25, 27
- **阻擋：** SPEC-02、SPEC-03、SPEC-04、SPEC-05、SPEC-06、SPEC-07

---

## 1. 問題

- 服務只能在 `tsx` 下執行。`orchestrator.ts` 用 `.ts` 副檔名做
  `import(\`../skills/${folder}/saveFile.ts\`)`；`tsc` 產物會是 `.js`，直接壞。
  `package.json` 沒有 `start` script，但 README 叫使用者 `npm start`。`tsc` 不會
  複製 `SKILL.md`。執行期程式碼從 `process.cwd()/src/skills` 讀檔。沒有一致的
  「生產」路徑。
- `process.env` 在 `config/env.ts`、`gemini.ts`、`discord.ts` 各處隨意讀取。
  只有 `TG_TOKEN` 會警告；`DC_TOKEN` 靜默；沒有任何東西 fail fast。
- 模型名稱 `gemini-2.5-flash-lite` 寫死在 `gemini.ts`。
- 接線（`new`）散落在 `index.ts`、`CoreProcessor.ts`、`orchestrator.ts`、
  `web_summarizer/saveFile.ts`。
- 即使零 transport token，server 仍呼叫 `fastify.listen`；`/health` 不論實際
  readiness 都回 `ok`。
- `package.json` 有 `author: ""`、`main` 指向原始碼檔案；repo 缺
  `.editorconfig`／`.nvmrc`。

---

## 2. 目標／非目標

**目標**
- 一種 runtime/build 模式，端到端完整可用。
- 一個 config 模組，啟動時驗證，且是 `process.env` 的唯一存取點。
- 一個 composition root。
- 能反映真實 readiness 的健康檢查。

**非目標**
- AI client 內部（SPEC-02）、transport 內部（SPEC-03）。
- 超出「產出可執行成品並寫入文件」以外的 Docker／部署管線。

---

## 3. 目標設計

### 3.1 Runtime 與 build

二選一，並完整實作。建議：**方案 A**。

**方案 A — 直接跑 TypeScript，不做 build。**
- `start`：`node --import tsx src/main.ts`
- `dev`：`node --import tsx --watch src/main.ts`
- Prompt 檔（`prompt.md`）在執行期以
  `await readFile(new URL("./prompt.md", import.meta.url), "utf8")` 讀取 ——
  路徑相對於模組，而非 `process.cwd()`。
- 移除 `outDir`；`tsc` 只用於 `tsc --noEmit` 做型別檢查。
- 在 `.nvmrc` 與 `engines.node` 鎖定 Node 版本（`>=20.11` 讓
  `import.meta`-relative 讀取穩定；若日後要用原生 type stripping 則 `>=22`）。

**方案 B — 用 `tsup` 打包。**
- `tsup src/main.ts --format esm --target node20 --loader .md=text` → 單一
  `dist/main.js`，prompt 內嵌。
- `start`：`node dist/main.js`；`build`：`tsup`。
- `dist` 內的檔案不得為了程式碼／資產而參照 `src/` 或 `process.cwd()`。

無論哪一種：**不得有帶內插路徑的動態 `import()`**（見 SPEC-04 registry）。
`SKILL.md` frontmatter 解析一律移除。

### 3.2 `platform/config.ts`

```ts
import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),

  GEMINI_API_KEY: z.string().min(1),
  AI_MODEL: z.string().default("gemini-2.5-flash-lite"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),

  ALLOWED_USER_IDS: z.string().transform(s => s.split(",").map(x => x.trim()).filter(Boolean)),

  DATA_DIR: z.string().default("./data"),
  PROJECT_ROOTS: z.string().default("").transform(parseRootsMap), // "alias=/abs/path,alias2=/abs/path"

  LOG_LEVEL: z.enum(["fatal","error","warn","info","debug","trace"]).default("info"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
})
.refine(c => c.TELEGRAM_BOT_TOKEN || c.DISCORD_BOT_TOKEN, {
  message: "TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN 至少要設定一個",
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    console.error("設定無效：\n" + z.prettifyError(parsed.error));
    process.exit(1);
  }
  return parsed.data;
}
```

- `loadConfig()` 在 `main.ts` 只呼叫一次，然後往下傳。其他模組不 import
  `process.env`。
- `.env.example` 列出每個 key 並附註解，納入版控。

### 3.3 `platform/logger.ts`

- `pino`（已透過 `fastify` 間接存在）。
- 匯出一個 base logger 與 `childLogger(bindings)`，供 request 範圍的 logging
  帶上 `correlationId`。
- Level 來自 `config.LOG_LEVEL`。只有 `NODE_ENV === "development"` 時用 pretty
  transport。

### 3.4 `platform/errors.ts`

```ts
export class AppError extends Error {
  constructor(message: string, readonly code: string, readonly operational = true) {
    super(message);
    this.name = new.target.name;
  }
}
export class ConfigError extends AppError {}
export class AiError extends AppError {}          // SPEC-02
export class TransportError extends AppError {}   // SPEC-03
export class SkillError extends AppError {}       // SPEC-04
export class SecurityError extends AppError {}    // SPEC-06
```

- `operational` 區分「預期的失敗」（給使用者友善訊息）與「bug」（以 `error`
  等級記 log、給使用者通用訊息、不讓進程崩潰）。

### 3.5 `main.ts`（composition root）

職責，依序：
1. `const config = loadConfig();`
2. 建 logger、`AiClient`、`ArtifactWriter`、`Workspace`、`Router`、`Pipeline`、
   技能 registry。
3. 建立每個有設定的 `ChatTransport`，注入 `Gateway`。
4. 啟動 HTTP server（只有健康檢查），再 `gateway.start()`。
5. 註冊 `SIGINT`／`SIGTERM` → `gateway.stop()` ＋ `server.close()` → exit 0。
6. 任何啟動錯誤 → 記 log、盡力 `gateway.stop()`、exit 1。

這裡沒有業務邏輯 —— 只有接線。每個協作者都是建構子注入。

### 3.6 健康檢查端點

- `GET /livez` → 進程活著時 `200 {status:"ok"}`。
- `GET /readyz` → 只有在「至少一個 transport 回報 `connected`，且 AI client
  通過啟動憑證檢查（SPEC-02 FR-02-5）」時回 `200`。否則回 `503` 附機器可讀的
  原因清單。
- 移除目前的 `/health`；若想保留單一別名，`/health` → `/readyz`。

---

## 4. 需求

### FR-01-1 — 單一 runtime/build 模式，端到端可用
從 §3.1 選方案 A 或 B 並實作。`npm run start`（方案 B 另加 `npm run build`）
必須能從乾淨 checkout ＋ 僅提供 `.env` 就產出可執行的服務。
**驗收：** 乾淨 clone → `npm ci` → `npm run start` 能連上有設定的 transport 並回應
`/livez`。方案 B 時不得殘留任何只在 `tsx` 成立的假設。

### FR-01-2 — 無內插動態 import；資產以模組相對路徑解析
移除所有 `import(\`…${var}…\`)`。任何執行期讀取的檔案（prompt）都用
`new URL(..., import.meta.url)`，絕不用 `process.cwd()`。
**驗收：** `grep -rn "process.cwd()" src/` 無結果；
`grep -rn "import(\`" src/` 無結果。

### FR-01-3 — `platform/errors.ts` 型別化錯誤階層
依 §3.4 實作 `AppError` ＋ 子類別，帶 `code` 與 `operational`。
**驗收：** 所有子類別已匯出；單元測試驗證 `instanceof AppError` 與 `name`／`code`
正確傳遞。

### FR-01-4 — `platform/config.ts` 為唯一的 `process.env` 讀取點
依 §3.2 實作 zod schema，含 `AI_MODEL`、`AI_TIMEOUT_MS`、`AI_MAX_RETRIES`、
`ALLOWED_USER_IDS`、`DATA_DIR`、`PROJECT_ROOTS`。設定無效或缺必填時印出可讀報告
並以非零結束。
**驗收：** `grep -rn "process.env" src/` 只出現在 `platform/config.ts`
（與 `config.test.ts`）。測試：缺 `GEMINI_API_KEY` → 非零結束且訊息點名該 key。
測試：兩個 transport token 都沒有 → 以 refine 訊息結束。

### FR-01-5 — Composition root
所有 服務／adapter／pipeline 的 `new` 接線都在 `main.ts`。刪除 `CoreProcessor`
內部的 `new Orchestrator()`，以及任何技能裡的 `new GeminiAIService()`（技能透過
`SkillContext` 取得 AI，見 SPEC-04）。
**驗收：** `grep -rn "new .*(Service|Adapter|Orchestrator|Pipeline|Router|Writer)\b" src/`
只 match `src/main.ts`。

### FR-01-6 — 沒有可用 transport 就拒絕啟動
若沒有設定任何 transport，或每個有設定的 transport 都連線失敗，進程記 fatal
並以非零結束，而不是空轉 listen。
**驗收：** 設了 `ALLOWED_USER_IDS` 但兩個 token 都沒設 → 以非零結束（由 FR-01-4
refine 涵蓋）；設一個會讓 `start()` 失敗的無效 token → 非零結束、錯誤已記 log。

### FR-01-7 — 有意義的健康檢查
依 §3.6 實作 `/livez` 與 `/readyz`。
**驗收：** 整合測試：`gateway.start()` resolve 前 `/readyz` 回 503；一個 fake
transport 回報 connected 之後 `/readyz` 回 200。

### FR-01-8 — `package.json` scripts 與 metadata
新增 `start`、`dev`、`check`（`typecheck && lint && test`）、`typecheck`
（`tsc --noEmit`）。填 `author`、`license`、`description`、`engines.node`。
`main` 指對或移除。
**驗收：** `npm run check` 存在且會跑三個子步驟；`npm pkg get author engines.node`
非空。

### FR-01-9 — Repo runtime 版本鎖定
新增 `.nvmrc` 與 `.editorconfig`。`engines.node` 與 `.nvmrc` 一致。
**驗收：** 檔案存在；`.nvmrc` 版本滿足 `engines.node`。

### NFR-01-1 — 啟動順序
設定驗證發生在任何網路 I/O 之前。設定失敗絕不會留下半連線的 transport。
**驗收：** code review；`main.ts` 第一句就是 `loadConfig()`。

---

## 5. 建議 ticket

1. 加 `zod`、`pino`；建 `platform/config.ts` ＋ `.env.example` ＋ config 測試。*(FR-01-4)*
2. 建 `platform/errors.ts` ＋ 測試。*(FR-01-3)*
3. 建 `platform/logger.ts`，含 child-logger helper。*(支援 FR-01-4/7)*
4. 決定 runtime 模式（ADR），實作 scripts，移除 `outDir`/`tsc` emit 或加 `tsup`。*(FR-01-1)*
5. 把 `src/main.ts` 重寫成 composition root；刪掉散落的 `new`。*(FR-01-5, FR-01-6)*
6. 取代 `import(...)` 式載入假設；prompt 讀取改用 `import.meta.url`。*(FR-01-2 — 與 SPEC-04 一起完成)*
7. 實作 `/livez` ＋ `/readyz`；刪掉 `/health`。*(FR-01-7)*
8. `package.json` scripts ＋ metadata；加 `.nvmrc`、`.editorconfig`。*(FR-01-8, FR-01-9)*
