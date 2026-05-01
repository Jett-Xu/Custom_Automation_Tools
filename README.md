# Custom AI Automation Agent

這是一個基於 **Telegram & Discord 雙平台** 與 **LLM (預設使用 Google Gemini API)** 的智慧自動化代理系統。專案採用了高度優化的**微核心架構 (Plugin Architecture)** 與**依賴反轉 (Dependency Inversion)**，能夠根據使用者的自然語言指令，動態進行單次路由或建立**多 Agent 協作工作流 (Pipeline)** 來處理複雜任務（如從系統架構規劃、拆解到實作）。

## 🚀 核心亮點 (Architecture Highlights)

- **🤖 智慧動態路由與工作流 (Dynamic Multi-Agent Workflow)**: 核心調度器 (Orchestrator) 具備判斷力。若是簡單任務，直接單點觸發；若是「大型專案」需求，會自動組織 Pipeline 工作流（例如：規劃 -> 拆解 -> 實作），並自動將前一個 Agent 的產出作為下一個 Agent 的 Context。路由失敗時具備自動重試機制。
- **📱 雙通訊平台並行 (Multi-Platform Adapters)**: 透過抽象化的 `BotAdapter`，完全解耦了底層通訊。系統可同時運行 Telegram 與 Discord Bot。
- **🎯 專屬頻道模式切換 (Context-Aware Channels)**: 支援頻道感知。例如在 Discord 特定的「前端開發頻道」發送訊息，系統會自動切換至「前端開發模式」，優先過濾並選用前端及測試相關技能。
- **🧩 遵循開閉原則的技能系統 (Plug-and-Play Skills)**: 支援隨插即用的擴充。要加入全新功能，只需在 `src/skills/` 下建立資料夾與配置檔，系統會自動掃描載入（Dynamic Import）。技能清單在記憶體中快取，避免重複讀取磁碟。
- **⚡ 效能優化 (Performance)**: PathExtractor 目錄樹結果快取 5 分鐘；SkillLoader 結果啟動後常駐記憶體；掃描深度優化至 3 層，有效降低 AI Token 消耗。

## 📂 專案架構

本專案採用嚴謹的領域分層設計 (Clean Architecture)：

```text
src/
├── agents/          # 智慧代理層
│   └── orchestrator.ts  # 核心調度器 (技能路由、重試機制、多 Agent Pipeline)
├── core/            # 系統核心邏輯
│   ├── CoreProcessor.ts # 通訊平台與 AI 邏輯的解耦中樞
│   ├── io/              # I/O 策略層
│   │   ├── OutputManager.ts          # 輸出管理器（策略分派）
│   │   └── input-parsers/
│   │       └── PathExtractor.ts      # 本機路徑偵測與目錄樹注入（含快取）
│   └── strategies/       # 輸出策略實作
│       ├── OutputStrategy.ts   # 策略介面
│       ├── LocalOutput.ts      # 存至本地 output/
│       └── DesignatedOutput.ts # 存至使用者指定路徑
├── services/        # 基礎服務層 (Infra/Adapter)
│   ├── ai/          # AI 驅動封裝 (gemini.ts)
│   └── messenger/   # 雙通訊適配器 (botAdapter.ts, telegram.ts, discord.ts)
├── skills/          # 技能模組庫 (Domain Logic)
│   ├── skillLoader.ts   # 動態技能掃描載入器（含啟動快取）
│   ├── architect/       # 💡 系統架構規劃
│   ├── task-planner/    # 💡 任務拆解
│   ├── executor/        # 💡 程式碼實作
│   ├── test-strategy-advisor/ # 💡 前端測試策略分析
│   ├── test-case-writer/ # 💡 自動化測試撰寫
│   ├── web_summarizer/  # 💡 網頁重點摘要
│   └── todo/            # 💡 待辦事項
│       ├── SKILL.md     # 技能定義與 Prompt (YAML-like Frontmatter)
│       └── saveFile.ts  # 該技能專屬的執行邏輯 (Side-effects)
├── config/          # 全域環境變數管理 (env.ts)
└── index.ts         # 程式進入點 (DI 依賴注入、服務啟動、健康檢查)
```

## 🛠️ 安裝與設定

### 1. 安裝依賴庫
```bash
npm install
```

### 2. 環境變數設定
請在專案根目錄建立 `.env` 檔案，並填入以下配置：
```env
PORT=3000

# Google Gemini API 設定 (請前往 Google AI Studio 申請)
GEMINI_API_KEY=您的_Gemini_API_Key

# Telegram Bot 設定 (擇一或全填，填寫的平台會自動啟動)
TG_TOKEN=您的_Telegram_Bot_Token

# Discord Bot 設定 (需開啟 Message Content Intent)
DC_TOKEN=您的_Discord_Bot_Token
DC_FRONTEND_DEV_CHANNEL_ID=專屬前端開發頻道ID (選填，用於觸發前端開發模式)
```

## ▶️ 啟動專案

**開發模式 (支援熱重載):**
```bash
npm run dev
```

**編譯並執行 (生產環境):**
```bash
npm run build
npm start
```

**健康檢查：**
```bash
curl http://localhost:3000/health
# { "status": "ok", "timestamp": "...", "uptime": 123 }
```

## 🧩 如何新增擴充功能 (Skill)

1. 在 `src/skills/` 建立一個新資料夾（如 `expense_tracker`）。
2. 在裡面建立 **`SKILL.md`**，Frontmatter 的 `description` 需包含能反映用途的語意關鍵字（前端模式下若含 `frontend`/`react`/`vue`/`test` 等詞，會自動納入前端模式候選）：
    ```markdown
    ---
    name: 記帳小幫手
    description: 使用者告知花費時，轉譯為 JSON 格式
    ---
    # Role
    你是一個記帳工具，請將使用者的對話萃取出消費項目與金額...
    ```
3. 在同目錄建立 **`saveFile.ts`**，**必須**以 `execute` 為名匯出函式：
    ```typescript
    export const execute = async (content: string): Promise<string> => {
       // 1. 將 AI 輸出的內容 Parse 成物件
       // 2. 儲存至資料庫 或 打 API
       return "💰 記帳完成！金額已記錄。";
    };
    ```
4. 重啟服務，Orchestrator 會自動載入新技能。

> ⚠️ `saveFile.ts` 必須匯出名為 `execute` 的函式，系統啟動時會以 `typeof execute === "function"` 驗證，匯出格式錯誤將在執行時拋出明確錯誤訊息。

## 📝 技術棧

- **Runtime**: Node.js (TypeScript)
- **AI Core**: `@google/generative-ai` (Gemini 2.5 Flash Lite)
- **Web Framework**: Fastify（含 `/health` 健康檢查端點）
- **Bot Framework**: `telegraf` (Telegram), `discord.js` (Discord)

## 📖 延伸文件

- [WORKFLOW.md](./WORKFLOW.md) — 完整運作流程、架構分析與 Token 消耗說明
- [SKILLS-CONTENT.md](./SKILLS-CONTENT.md) — 所有內建技能的痛點、觸發點與運作說明
