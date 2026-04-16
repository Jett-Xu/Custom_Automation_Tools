# Custom AI Automation Agent

這是一個基於 **Telegram** 與 **LLM (預設使用 Google Gemini API)** 的智慧自動化代理系統。專案採用了高度優化的**微核心架構 (Plugin Architecture)** 與**依賴反轉 (Dependency Inversion)**，能夠根據使用者的自然語言指令，動態進行路由 (Routing) 並自動掛載合適的模組來處理複雜任務（如網頁爬蟲總結、資料結構化等）。

## 🚀 核心亮點 (Architecture Highlights)

- **🤖 兩步式智慧分流 (Two-Step Orchestrator)**: 核心調度器不將所有規則混雜於一次對話，而是先做「輕量化意圖分類」，確定目標後再動態載入對應的 `SKILL.md`。這大幅降低了 Token 成本並避免了 AI 幻覺 (Hallucination)。
- **🧩 遵循開閉原則的技能系統 (Plug-and-Play Skills)**: 支援隨插即用的擴充。要加入全新功能，只需在 `src/skills/` 下建立資料夾與配置檔，系統會自動掃描載入（Dynamic Import），免改核心路由即實現擴充。
- **🔌 高度解耦的 AI 引擎**: AI 服務被抽象為 `AIService` 介面，無論切換至 Gemini、GitHub Copilot SDK 或是 OpenAI，主程式依然無縫運作，展現了強大的代碼可維護性。
- **💬 對話即操作 (Conversational UI)**: 透過 Telegram Bot 介面，讓傳統的 CLI / 面板工具轉型為隨時隨地的 Mobile-First 助理。

## 📂 專案架構

本專案採用嚴謹的領域分層設計：

```text
src/
├── agents/          # 智慧代理層
│   └── orchestrator.ts  # 核心調度器 (負責技能路由與兩步式 Prompt 分派)
├── services/        # 基礎服務層 (Infra/Adapter)
│   ├── ai/          # AI 驅動封裝 (目前核心為 gemini.ts)
│   └── messenger/   # 訊息服務整合 (Telegram Bot)
├── skills/          # 技能模組庫 (Domain Logic)
│   ├── skillLoader.ts   # 動態技能掃描載入器
│   ├── web_summarizer/  # 💡 內建技能: 智慧網頁抓取與重點摘要
│   └── todo/            # 💡 內建技能: 待辦事項整理
│       ├── SKILL.md     # 技能定義與 Prompt (YAML-like Frontmatter)
│       └── saveFile.ts  # 該技能專屬的執行邏輯 (Side-effects)
├── config/          # 全域環境變數管理
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
# Telegram Bot 設定 (請向 @BotFather 申請)
TG_TOKEN=您的_Telegram_Bot_Token

# Google Gemini API 設定 (請前往 Google AI Studio 申請)
GEMINI_API_KEY=您的_Gemini_API_Key
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
2. 在裡面建立 **`SKILL.md`**，設定讓 AI 將自然語言轉換為對應輸出（例如強迫輸出 JSON Schema）：
    ```markdown
    ---
    name: 記帳小幫手
    description: 使用者告知花費時，轉譯為 JSON 格式
    ---
    你是一個記帳工具，請將使用者的對話萃取出消費項目與金額，並回傳格式化的 JSON...
    ```
3. 在同目錄建立 **`saveFile.ts`**，承接 AI 產出的字串並執行實際操作 (Side-effect)：
    ```typescript
    export async function execute(aiContent: string) {
       // 1. 將 AI 輸出的 JSON Parse 成物件
       // 2. 儲存至資料庫 或 打 API
       return "💰 記帳完成！金額已記錄。";
    }
    ```
新增完畢後，不須重啟專案，Orchestrator 會立刻學會並應用此新功能！

## 📝 技術棧

- **Runtime**: Node.js (TypeScript)
- **AI Core**: `@google/generative-ai` (Gemini Flash 2.0/1.5)
- **Web Framework**: Fastify
- **Bot Framework**: Telegraf (Telegram API)
