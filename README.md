# Custom Automation Tools

這是一個基於 **GitHub Copilot SDK** 與 **Telegram** 的智慧自動化代理系統。它具備強大的**動態技能擴充 (Dynamic Skills)** 與 **智慧調度 (Intelligent Orchestration)** 能力，能夠根據使用者的自然語言指令，自動選擇合適的工具來完成任務。

## 🚀 核心功能

- **🤖 下一代 AI 驅動**: 深度整合 `@github/copilot-sdk` (GPT-4o)，提供精準的語意理解與內容生成。
- **🧠 智慧路由 (Orchestrator)**: 核心調度器會分析使用者意圖，自動將請求與現有技能庫進行匹配，分派給最適合的技能處理。
- **🧩 動態技能系統 (Modular Skills)**:
  - 採用隨插即用的技能架構。
  - 只需在 `src/skills/` 下新增目錄與定義檔，系統即可自動識別新能力。
- **💬 Telegram 互動介面**: 使用者可透過 Telegram Bot 直接與 AI 代理對話，獲得即時反饋。
- **⚡ Fastify 伺服器**: 輕量且高效的後端架構。

## 📂 專案架構

本專案採用模組化架構設計：

```text
src/
├── agents/          # 智慧代理層
│   └── orchestrator.ts  # 核心調度器 (負責技能路由與分派)
├── services/        # 基礎服務層 (Infra/Adapter)
│   ├── ai/          # AI 服務整合 (Copilot SDK)
│   └── messenger/   # 訊息服務整合 (Telegram Bot)
├── skills/          # 技能模組庫 (Domain Logic)
│   ├── skillLoader.ts   # 技能載入器
│   └── [skill_name]/    # 個別技能資料夾 (例如: todo)
│       ├── SKILL.md     # 技能定義與 Prompt (YAML Frontmatter)
│       └── saveFile.ts  # 技能執行邏輯
├── config/          # 全域設定
└── index.ts         # 程式進入點 (Server & Service 初始化)
```

## 🛠️ 安裝與設定

### 1. 安裝依賴

```bash
npm install
```

### 2. 環境變數設定

請在專案根目錄建立 `.env` 檔案，並填入以下資訊：

```env
PORT=3000
TG_TOKEN=你的_Telegram_Bot_Token
# Copilot SDK 會自動讀取環境中的 GitHub 認證，確保你已登入 GitHub Copilot
```

### 3. @github/copilot-sdk 認證

由於專案使用 Copilot SDK，請確保運行環境具備 GitHub Copilot 的存取權限。

## ▶️ 啟動專案

**開發模式 (使用 tsx 監聽變更):**

```bash
npm run dev
```

**編譯並執行:**

```bash
npm run build
node dist/index.js
```

## 🧩 如何新增技能 (Skill)

要擴充機器人的功能，無需修改核心與路由代碼，只需在 `src/skills/` 下按照標準結構新增資料夾即可。

**步驟：**

1.  在 `src/skills/` 建立一個新資料夾，例如 `weather_reporter`。
2.  建立 `SKILL.md` (定義技能元數據與 System Prompt)：

    ```markdown
    ---
    name: weather_reporter
    description: 當使用者詢問天氣資訊時使用。
    ---

    # Role: Weather Expert

    你是一個天氣專家，請分析使用者的詢問...
    ```

3.  建立 `saveFile.ts` (定義執行邏輯)：

    ```typescript
    // src/skills/weather_reporter/saveFile.ts
    export async function execute(aiContent: string) {
      // 這裡可以實作自定義邏輯，例如呼叫外部 API 或儲存檔案
      console.log("收到 AI 內容:", aiContent);
      return "天氣報告已生成！";
    }
    ```

系統會自動掃描並載入這個新技能。當使用者詢問相關問題時，Orchestrator 就會自動將其導向至此技能。

## 📝 技術棧

- **Runtime**: Node.js
- **Language**: TypeScript
- **Web Framework**: Fastify
- **AI Core**: @github/copilot-sdk
- **Bot Framework**: Telegraf
