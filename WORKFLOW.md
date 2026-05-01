# Custom_Automation_Tools — 完整專案審視報告

> 本文件記錄本專案的架構分析、效能評估與完整運作流程（最後更新：2026-05-01）

---

## 一、專案優點 ✅

### 1. 架構分層清晰（Strategy + Adapter Pattern）
- `BotAdapter` 抽象類別明確隔離平台（Telegram / Discord），新增第三個平台（例如 LINE）只需實作 4 個方法。
- `OutputStrategy` 策略模式使「存到本地」與「存到指定路徑」完全解耦，未來可擴展 S3、GitHub PR 等策略，不需動 Skill 本身。

### 2. Middleware 概念的 PathExtractor
- `PathExtractor.enrichPrompt()` 在訊息進入 Orchestrator 前，自動偵測並展開本地目錄樹，形成類似 Express Middleware 的概念，設計意圖優良。

### 3. Skill 自動探索（Convention over Configuration）
- `SkillLoader.loadAll()` 掃描 `src/skills/` 所有子資料夾，零設定新增 Skill，降低維護人工成本。

### 4. Pipeline（多技能串聯）支援
- Orchestrator 支援 AI 路由回傳 `architect,task-planner,executor` 形式的 Pipeline，前一步驟輸出可作為下一步驟的輸入，具備 Agentic 自動化能力。

### 5. 降級（Fallback）策略完整
- `saveFile.ts` 的 `try/catch` 降級區塊：JSON 解析失敗時自動改為純字串存檔，不會因 LLM 格式問題導致整個流程崩潰。

### 6. 型別安全（TypeScript）
- 使用 TypeScript + Interface 定義 `AIService`、`BotAdapter`、`OutputStrategy`，依賴注入，可測試性良好。

---

## 二、已修正的問題 ✅

> 以下原本列為缺點的項目，已完成修正。

### ✅ 已修正：Skill 路由重試機制（原高嚴重度）
- `orchestrator.ts` 新增自動重試邏輯：若 AI 路由回傳的 `folder_name` 在已知 Skill 清單中均不存在，自動觸發第二次路由呼叫，降低幻覺導致的失敗率。

### ✅ 已修正：PathExtractor Regex 過於寬鬆（原中嚴重度）
- 舊版：`/(\\/(?:[a-zA-Z0-9_-]+\\/)+[a-zA-Z0-9_-]+)/g`（可能誤匹配 `/api/v1/users`）
- 新版：限制只匹配 `/Users/`、`/home/`、`/opt/` 等明確的本機路徑前綴，避免誤觸發。

### ✅ 已修正：isFrontendDevMode 篩選邏輯脆弱（原中嚴重度）
- `orchestrator.ts` 加入 `testKeywords` 白名單（`test`, `spec`, `qa`, `testing`）：測試類 Skill 的 `folder` 名稱含這些關鍵字時，一律保留在前端模式的候選清單中，不被篩除。

### ✅ 已修正：Skill saveFile.ts 無型別保護（原中嚴重度）
- `orchestrator.ts` 在 dynamic import 後，加入 `typeof skillModule.execute !== "function"` 檢查，提前丟出有意義的錯誤訊息，而非等 Runtime 噴出難以追蹤的 TypeError。

### ✅ 已修正：Fastify HTTP Server 為空殼（原低嚴重度）
- `index.ts` 新增 `GET /health` 端點，回傳 `{ status, timestamp, uptime }`，確認服務正常存活。

### ✅ 已修正：env.ts 重複警告（原低嚴重度）
- 移除 `index.ts` 中重複的 `TG_TOKEN` 警告，統一由 `env.ts` 負責啟動時自我檢查。

### ⏭️ 略過：Rate Limit（個人本地使用，無意義）
- 本系統為個人本地單機使用，無多使用者並發問題，略過此項。

### ⏭️ 略過：日誌分級與持久化（低優先）
- 個人使用場景下，`console.log` 已足夠，不引入額外依賴。

---

## 三、可擴展性評估 🔮

| 維度 | 評分 | 說明 |
|---|---|---|
| 新增 Bot 平台 | ⭐⭐⭐⭐⭐ | 只需實作 BotAdapter 抽象類別 |
| 新增 AI 模型 | ⭐⭐⭐⭐⭐ | 只需實作 AIService Interface |
| 新增 Skill | ⭐⭐⭐⭐⭐ | 建資料夾 + SKILL.md + saveFile.ts，無需重啟即生效 |
| 新增輸出策略 | ⭐⭐⭐⭐⭐ | OutputStrategy 介面完整，可直接擴展 S3/GitHub PR 等 |
| 新增 Input Parser | ⭐⭐⭐⭐☆ | 架構上可在 CoreProcessor 串接多個 Parser，但目前未抽象化 |

---

## 四、效能分析與 AI Token 消耗 ⚡

### 4.1 Token 消耗熱點總覽

| 觸發點 | 消耗等級 | 說明 |
|---|---|---|
| PathExtractor 展開目錄樹 | 🟡 **中**（已優化） | 深度從 4→3，節省約 30%；5 分鐘快取避免重複消耗 |
| Orchestrator Router（第一次 AI 呼叫） | 🟡 **中** | System Prompt = Skill descriptions（約 800–1,500 tokens）|
| Skill 執行（第二次 AI 呼叫） | 🔴 **大** | System Prompt = 完整 SKILL.md（可達 1,000–3,000 tokens）|
| Pipeline 後續步驟 | 🔴 **極大** | 累積前步驟輸出，可能達 5,000+ tokens/步 |
| 存檔 I/O | 🟢 **零** | 純本地 I/O，不消耗 Token |

### 4.2 單次請求估算（含路徑掃描，快取未命中）

```
[Router 呼叫]
  System: ~1,200 tokens（所有 Skill descriptions）
  User:   ~300 tokens（訊息）+ ~1,000 tokens（目錄樹，深度3）= ~1,300 tokens
  小計：  ~2,500 tokens

[Skill 執行呼叫]
  System: ~2,500 tokens（完整 SKILL.md）
  User:   ~1,300 tokens（同上）
  小計：  ~3,800 tokens

單次請求總計：約 6,000–8,000 tokens（已優化，原估算 7,000–10,000）
快取命中時：目錄樹消耗歸零，可再省 ~1,000 tokens
```

---

## 五、完整運作流程 🗺️

```
使用者
  │
  ▼
╔═════════════════════════════════════╗
║  Telegram / Discord 訊息輸入         ║
║  (telegram.ts / discord.ts)         ║
╚═══════════════════╤═════════════════╝
                    │ MessageContext { chatId, text, platform, isFrontendDevMode }
                    ▼
╔═════════════════════════════════════╗
║  CoreProcessor.handleMessage()      ║  ← src/core/CoreProcessor.ts
║  1. 發送「⏳ 正在處理...」提示至 Bot  ║
╚═══════════════════╤═════════════════╝
                    │
                    ▼
╔══════════════════════════════════════════╗
║  PathExtractor.enrichPrompt()            ║  ← src/core/io/input-parsers/PathExtractor.ts
║  偵測訊息中是否含有本機絕對路徑           ║
║  ├─ 無路徑 → 原樣傳遞                    ║
║  ├─ 有路徑（快取命中）→ 回傳快取目錄樹    ║
║  └─ 有路徑（快取未命中）                 ║
║      → 掃描目錄樹（深度 3 層）           ║
║      → 存入快取（TTL = 5 分鐘）          ║
║      → 注入系統結構報告至 Prompt         ║
║  【Token 消耗：🟡 中（首次），🟢 零（快取）】║
╚═══════════════════╤══════════════════════╝
                    │ 已富化的 context.text
                    ▼
╔══════════════════════════════════════════╗
║  Orchestrator.dispatch()                 ║  ← src/agents/orchestrator.ts
║  1. SkillLoader.loadAll()（記憶體快取）   ║
║  2. 若 isFrontendDevMode                 ║
║     → 前端關鍵字篩選 availableSkills     ║
║     → 測試類 Skill（test/spec/qa）白名單  ║
║  3. 組合 Router System Prompt            ║
╚═══════════════════╤══════════════════════╝
                    │
                    ▼
╔═════════════════════════════════════╗
║  【第 1 次 AI 呼叫】路由判斷         ║  ← src/services/ai/gemini.ts
║  System: Skill 清單 descriptions    ║
║  User:   使用者訊息 [+ 目錄樹]       ║
║  Output: folder_name 字串           ║
║  → 若無有效 Skill，自動重試一次      ║
║  【Token 消耗：🟡 中，~2,500 tokens】 ║
╚═══════════════════╤═════════════════╝
                    │ "test-strategy-advisor" 或 "architect,task-planner,executor"
                    ▼
╔══════════════════════════════════════╗
║  解析 selectedFolders[]              ║
║  啟動 Pipeline 迴圈                   ║
╚═══════════════╤══════════════════════╝
                │
      ┌─────────┴─────────┐
      ▼                   ▼
[單一 Skill]       [Pipeline 多步驟]
      │                   │ 前一步輸出 → 下一步 User Prompt
      └─────────┬─────────┘
                ▼
╔═════════════════════════════════════╗
║  【第 2~N 次 AI 呼叫】技能執行       ║  ← src/services/ai/gemini.ts
║  System: SKILL.md 完整內容           ║
║  User:   訊息 [+ 目錄樹] [+ 前步驟] ║
║  Output: Skill 產物（Markdown/JSON）║
║  【Token 消耗：🔴 大，~3,800 tokens/步】║
╚═══════════════════╤═════════════════╝
                    │ AI 產出的原始字串
                    ▼
╔═════════════════════════════════════╗
║  Dynamic Import saveFile.ts         ║  ← src/skills/{folder}/saveFile.ts
║  1. typeof execute 型別保護確認      ║  ← 新增
║  2. 解析 JSON（若有）               ║
║     └─ 萃取 detectedPath, content   ║
║  3. OutputManager.save()            ║  ← src/core/io/OutputManager.ts
║     ├─ detectedPath → DesignatedOutput（指定路徑）
║     └─ 無路徑 → LocalOutput（本地）  ║
║  4. 降級：JSON 解析失敗 → 純字串存檔  ║
║  【Token 消耗：🟢 零（純 I/O）】      ║
╚═══════════════════╤═════════════════╝
                    │ 結果訊息字串
                    ▼
╔═════════════════════════════════════╗
║  CoreProcessor 回傳最終結果至 Bot    ║
╚═════════════════════════════════════╝
                    │
                    ▼
              使用者收到回覆
        成品已存至 output/ 目錄
```

---

## 六、各流程節點 Token 消耗彙整（優化後）

| 步驟 | 對應檔案 | Token 消耗 | 備註 |
|---|---|---|---|
| ① 路徑偵測與目錄注入 | `PathExtractor.ts` | 🟡 **中（首次）**/ 🟢 **零（快取）** | 深度 3 層，5 分鐘 TTL 快取 |
| ② Skill 清單 Router | `orchestrator.ts` + `gemini.ts` | 🟡 **中** | ~2,500 tokens，每次請求固定發生 |
| ③ Skill 執行（單次） | `SKILL.md` + `gemini.ts` | 🔴 **大** | ~3,800 tokens |
| ④ Pipeline 後續步驟 | 累積前步驟輸出 + `gemini.ts` | 🔴 **極大** | 每步驟累加，可達 10,000+ tokens |
| ⑤ 存檔 I/O | `saveFile.ts` + `OutputManager.ts` | 🟢 **零** | 純本地 I/O，不消耗 Token |

---

*最後更新：2026-05-01*
