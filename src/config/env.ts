// src/config/env.ts
import * as dotenv from "dotenv";
import path from "path";

// 確保讀取到專案根目錄的 .env
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
export const ENV = {
  PORT: process.env.PORT || "3000",
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  COPILOT_API_KEY: process.env.COPILOT_API_KEY || "",
  AI_PROVIDER: process.env.AI_PROVIDER || "copilot",
};

// 啟動時自我檢查
if (!ENV.TELEGRAM_TOKEN) {
  console.warn("⚠️ 警告：未設定 TELEGRAM_TOKEN，Telegram 模組將無法運作");
}
