# Custom AI Automation Agent

這是一個基於 **Telegram & Discord 雙平台** 與 **LLM (預設使用 Google Gemini API)** 的智慧自動化代理系統。專案採用了高度優化的**微核心架構 (Plugin Architecture)** 與**依賴反轉 (Dependency Inversion)**，能夠根據使用者的自然語言指令，動態進行單次路由或建立**多 Agent 協作工作流 (Pipeline)** 來處理複雜任務（如從系統架構規劃、拆解到實作）。

## 🚀 核心亮點 (Architecture Highlights)

- **🤖 智慧動態路由與工作流 (Dynamic Multi-Agent Workflow)**: 核心調度器 (Orchestrator) 具備判斷力。若是簡單任務，直接單點觸發；若是「大型專案」需求，會自動組織 Pipeline 工作流（例如：規劃 -> 拆解 -> 實作），並自動將前一個 Agent 的產出作為下一個 Agent 的 Context。
- **📱 雙通訊平台並行 (Multi-Platform Adapters)**: 透過抽象化的 `BotAdapter`，完全解耦了底層通訊。系統可同時運行 Telegram 與 Discord Bot。
- **🎯 專屬頻道模式切換 (Context-Aware Channels)**: 支援頻道感知。例如在 Discord 特定的「前端開發頻道」發送訊息，系統會自動切換至「前端開發模式」，優先過濾並選用前端相關技能。
- **🧩 遵循開閉原則的技能系統 (Plug-and-Play Skills)**: 支援隨插即用的擴充。要加入全新功能，只需在 `src/skills/` 下建立資料夾與配置檔，系統會自動掃描載入（Dynamic Import）。

## 📂 專案架構

本專案採用嚴謹的領域分層設計 (Clean Architecture)：

```text
src/
├── agents/          # 智慧代理層
│   └── orchestrator.ts  # 核心調度器 (負責技能路由與多 Agent 工作流串接)
├── core/            # 系統核心邏輯
│   └── CoreProcessor.ts # 通訊平台與 AI 邏輯的解耦中樞
├── services/        # 基礎服務層 (Infra/Adapter)
│   ├── ai/          # AI 驅動封裝 (gemini.ts)
│   └── messenger/   # 雙通訊適配器 (botAdapter.ts, telegram.ts, discord.ts)
├── skills/          # 技能模組庫 (Domain Logic)
│   ├── skillLoader.ts   # 動態技能掃描載入器
│   ├── architect/       # 💡 內建技能: 系統架構規劃
│   ├── task-planner/    # 💡 內建技能: 任務拆解
│   ├── executor/        # 💡 內建技能: 程式碼實作
│   ├── web_summarizer/  # 💡 內建技能: 網頁重點摘要
│   └── todo/            # 💡 內建技能: 待辦事項
│       ├── SKILL.md     # 技能定義與 Prompt (YAML-like Frontmatter)
│       └── saveFile.ts  # 該技能專屬的執行邏輯 (Side-effects)
├── config/          # 全域環境變數管理 (env.ts)
└── index.ts         # 程式進入點 (DI 依賴注入與服務啟動)
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

# Discord Bot 設定 (擇一或全填，需開啟 Message Content Intent)
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

## 🧩 如何新增擴充功能 (Skill)

要為機器人擴充一個會「呼叫外部 API」或「連結資料庫」的新功能，請遵循以下步驟：

1. 在 `src/skills/` 建立一個新資料夾（如 `expense_tracker`）。
2. 在裡面建立 **`SKILL.md`**，設定讓 AI 將自然語言轉換為對應輸出：
    ```markdown
    ---
    name: 記帳小幫手
    description: 使用者告知花費時，轉譯為 JSON 格式
    ---
    # Role
    你是一個記帳工具，請將使用者的對話萃取出消費項目與金額...
    ```
3. 在同目錄建立 **`saveFile.ts`**，承接 AI 產出的字串並執行實際操作 (Side-effect)：
    ```typescript
    export async function execute(content: string) {
       // 1. 將 AI 輸出的內容 Parse 成物件
       // 2. 儲存至資料庫 或 打 API
       return "💰 記帳完成！金額已記錄。";
    }
    ```
新增完畢後，不須重啟專案，Orchestrator 會立刻學會並自動應用此新功能！

## 📝 技術棧

- **Runtime**: Node.js (TypeScript)
- **AI Core**: `@google/generative-ai` (Gemini Flash 2.0 / 1.5)
- **Web Framework**: Fastify
- **Bot Framework**: `telegraf` (Telegram), `discord.js` (Discord)
