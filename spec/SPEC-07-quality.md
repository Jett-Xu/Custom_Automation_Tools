# SPEC-07 — 品質：測試、CI、文件、Repo 衛生

> **v2 勘誤：** SPEC-04／05 已刪除，由 SPEC-09（Run Store ＋ ArtifactWriter）、
SPEC-10（Agent Runtime ＋ Playbook）、SPEC-11（Plan／Execute／Verify 編排）取代。
本文中的「SPEC-04」請讀作 SPEC-09／10，「SPEC-05」請讀作 SPEC-11，
「Skill」請讀作 Playbook。詳見 SPEC-00 §0。

- **狀態：** 草稿
- **負責人：** 待定
- **依賴：** 觸及其他每一份 spec；隨它們逐步落地
- **對應的原始發現：** 23, 25, 26, 27

---

## 1. 問題

- `npm test` 是預設 stub。零測試，而這個專案的技能還包含 `test-strategy-advisor`
  與 `test-case-writer`。
- 沒有 linter、沒有 formatter config、沒有 CI、沒有 pre-commit。
- `WORKFLOW.md` 描述的流程與程式碼不符（`OutputManager` 作為 pipeline 關卡、
  `npm start`、「不重啟即熱重載」）。README 宣稱 `npm start`（無此 script）與
  熱重載（快取從不失效）。
- `SKILLS-CONTENT.md` 是手工維護的技能目錄，會漂移。
- `package.json`：`author: ""`、`license: ISC` 未經審視、`main` → 原始碼檔案。
- `.gitignore` 帶著 `TODO.md`（把個人檔案偷渡進 ignore 規則）。

---

## 2. 目標／非目標

**目標**
- 一個 `npm run check` 閘（typecheck ＋ lint ＋ test），CI 在每個 PR 執行。
- 對純邏輯與 contract 有意義的測試覆蓋；一條端到端路徑。
- 文件是衍生的或可驗證的，不是用敘述的。
- 乾淨的 repo metadata 與 ignore 規則。

**非目標**
- 100% 覆蓋率目標。
- 壓力／效能測試。
- 把套件發佈到 registry。

---

## 3. 目標設計

### 3.1 工具

| 面向 | 選擇 | Config |
|------|------|--------|
| 測試 runner | `vitest` | `vitest.config.ts`，`environment: "node"` |
| Lint | `eslint`（flat config）＋ `typescript-eslint` | `eslint.config.js` |
| Format | `prettier` | `.prettierrc`，`check` 內跑 `prettier --check` |
| Typecheck | `tsc --noEmit` | 現有 `tsconfig.json` |
| Pre-commit（選配） | `husky` ＋ `lint-staged` | 對 staged 檔案跑 format ＋ `check` |
| CI | GitHub Actions | `.github/workflows/ci.yml` |

`package.json` scripts：
```json
{
  "check": "npm run typecheck && npm run lint && npm run test",
  "typecheck": "tsc --noEmit",
  "lint": "eslint . && prettier --check .",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

### 3.2 把架構編碼進 lint 規則

- `no-restricted-imports`：`fs`、`fs/promises`、`node:fs` 在 `src/skills/**` 禁止
  （SPEC-04 FR-04-8）；SDK 在 `src/platform/**` 以外禁止。
- `no-restricted-globals`：`fetch` 在 `src/skills/**` 禁止（SPEC-06 FR-06-8）。
- `no-restricted-syntax`：標記帶 template literal 參數的 `import(`
  （SPEC-01 FR-01-2）。
- `no-restricted-properties`：`process.env` 在 `src/platform/config.ts` 以外禁止
  （SPEC-01 FR-01-4）。

### 3.3 測試分層

| 層 | 測什麼 | 風格 |
|----|--------|------|
| 純單元 | `confineWithin`、`slugify`、`stamp`、`isPrivateIp`、config 解析、`channel-profiles`、router JSON 驗證 | 樸素，無 mock |
| Platform | `safeFetch`（stub resolver ＋ `fetch`）、`Workspace.scanTree`（暫存目錄）、`ArtifactWriter`（暫存目錄）、`AiClient` retry/error（stub SDK） | 只在邊界 fake/stub |
| 技能 contract | 每個技能：樣本 LLM 輸出 → `outputSchema` 接受 ＋ `toArtifacts` 輸出 | fake `AiClient` |
| Pipeline | router ＋ 步驟 ＋ writer 接線、錯誤傳播、順序 | fake `AiClient`、暫存 `DATA_DIR` |
| 端到端 | `FakeTransport` ＋ fake `AiClient` → 訊息進 → 磁碟上的檔案 ＋ 回覆字串；auth 拒絕；去重；per-user 序列化 | 只用 fake，無網路 |

不做模組層 mock（沒有 `vi.mock("../skills/...")`）。seam 是注入的依賴與
`platform/*` 邊界。

### 3.4 文件

- **README.md** — 重寫成：這是什麼、前置需求、`.env` keys（連到
  `.env.example`）、`npm run start`／`dev`／`check`、「加一個技能」（3 檔流程，
  SPEC-04 NFR-04-1）、架構圖（Mermaid，內嵌）。每一句宣稱都必須對應到存在的
  程式碼。
- **刪除 `WORKFLOW.md`。** 若要流程圖，它住在 README 裡當 Mermaid，並隨程式碼
  變更一起 review。
- **刪除 `SKILLS-CONTENT.md`。** 換成 `npm run skills:list` —— 一個從
  `registry.ts` 印出 `id`、`tags`、`description` 的 script。或可把它的輸出提交成
  `docs/skills.md`，由 CI 重新產生（過期就失敗）。
- **`spec/`** — 這組文件。作為設計紀錄保留；每份的 `狀態：` 從 `草稿` →
  `已接受` → `已實作`。
- **ADR** — 對超出 ticket 生命週期的決策寫短的 `docs/adr/NNNN-*.md`：
  runtime/build 模式（SPEC-01）、no-match 策略（SPEC-05）、供應商隔離
  （SPEC-02）。

### 3.5 Repo 衛生

- `.gitignore`：`node_modules`、`dist`、`data/`、`.env`、coverage。移除
  `TODO.md`（用 issue tracker 追蹤工作，或提交真的 `docs/roadmap.md`）。
- 加 `.editorconfig`、`.nvmrc`、`.prettierrc`、`.prettierignore`。
- `package.json`：真的 `author`、審視過的 `license`、`description`、
  `engines.node`、移除或修正 `main`、加 `"private": true`。
- `.env.example` 提交；`.env` 永不提交。
- 選配：`CONTRIBUTING.md` 指向 `spec/` 與 `npm run check`。

---

## 4. 需求

### FR-07-1 — 測試 runner ＋ `check` 閘
加 `vitest`；依 §3.1 實作 `check`／`typecheck`／`lint`／`test` scripts。
**驗收：** `npm run check` 跑三個階段，任一失敗則失敗。

### FR-07-2 — 安全與路由邏輯的純單元覆蓋
以下都有測試：`confineWithin`、`slugify`、`isPrivateIp`、`config` 解析
（happy ＋ 每個必填缺漏）、`channel-profiles`、router 結果驗證。
**驗收：** 每個函式 ≥1 個 happy ＋ ≥1 個 failure 測試；`vitest run` 綠燈。

### FR-07-3 — 邊界 ＋ contract ＋ 端到端測試
依 §3.3：`safeFetch`、`Workspace.scanTree`、`ArtifactWriter`、`AiClient`
retry/error 各有測試；每個技能有 contract 測試；一個用 fake 的完整端到端測試
涵蓋 訊息→檔案→回覆 加上 auth 拒絕與去重。
**驗收：** 列出的測試檔案存在且通過；端到端測試寫到暫存目錄並斷言檔案內容 ＋
回覆文字。

### FR-07-4 — 強制架構的 lint 規則
實作 §3.2 的 `no-restricted-*` 規則。
**驗收：** 在暫存檔中故意違反每條規則會讓 `npm run lint` 失敗；真的樹通過。

### FR-07-5 — CI
`.github/workflows/ci.yml` 在 push 與 PR 時、以 `.nvmrc` 的 Node 版本執行
`npm ci && npm run check`。
**驗收：** PR 顯示 CI 檢查；失敗的測試會擋住它。

### FR-07-6 — 重寫 README ＋ 刪漂移文件
依 §3.4 重寫 README；刪 `WORKFLOW.md` 與 `SKILLS-CONTENT.md`；加
`npm run skills:list`。沒有文件陳述不存在的 script 或行為。
**驗收：** `grep -rn "npm start\|OutputManager\|hot.reload\|無需重啟" README.md`
無結果；`WORKFLOW.md`／`SKILLS-CONTENT.md` 不存在；`skills:list` 印出 registry。

### FR-07-7 — Repo metadata 與 ignore 衛生
套用 §3.5：`.gitignore` 清理、`TODO.md` 從中移除、加 `.editorconfig`／
`.nvmrc`／`.prettierrc`、填 `package.json` metadata、提交 `.env.example`。
**驗收：** `npm pkg get author license engines.node private` 全部非空；
`git check-ignore TODO.md` → 未被 ignore（檔案已追蹤或已刪）；`.env.example`
存在。

### FR-07-8 — 對持久決策寫 ADR
加 `docs/adr/`，內含 runtime/build 模式、no-match 策略、供應商隔離的條目。
**驗收：** 三個 ADR 檔案存在，各有 Context／Decision／Consequences。

### NFR-07-1 — 測試隨功能一起落地
每張 SPEC-01…06 的 ticket 都包含自己的測試；SPEC-07 加的是測試骨架、CI、
跨領域端到端測試與文件 —— 它不是「最後才寫所有測試」的桶子。
**驗收：** review —— 沒有 SPEC-01…06 的 PR 在缺該需求測試的情況下合併。

---

## 5. 建議 ticket

1. 加 `vitest` ＋ config ＋ `check`／`typecheck`／`lint`／`test` scripts。*(FR-07-1)*
2. 加 `eslint` flat config ＋ `prettier` ＋ `.prettierrc` ＋ 架構 lint 規則。*(FR-07-4)*
3. 加 `.github/workflows/ci.yml`。*(FR-07-5)*
4. 補純單元測試（安全 ＋ 路由 helper）。*(FR-07-2)*
5. 補邊界測試（`safeFetch`、`workspace`、`artifacts`、`ai`）。*(FR-07-3)*
6. 用 fake 的跨領域端到端測試。*(FR-07-3)*
7. `npm run skills:list` script（＋ 選配 `docs/skills.md` 過期檢查）。*(FR-07-6)*
8. 重寫 README；刪 `WORKFLOW.md` ＋ `SKILLS-CONTENT.md`。*(FR-07-6)*
9. Repo 衛生：`.gitignore`、`.editorconfig`、`.nvmrc`、`package.json` metadata、`.env.example`。*(FR-07-7)*
10. `docs/adr/` 起始 ＋ 三份決策紀錄。*(FR-07-8)*
