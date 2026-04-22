// src/config/env.ts
import * as dotenv from "dotenv";
import path from "path";

// 確保讀取到專案根目錄的 .env
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
export const ENV = {
  PORT: process.env.PORT || "3000",
  TG_TOKEN: process.env.TG_TOKEN || "",
  DC_TOKEN: process.env.DC_TOKEN || "",
  DC_FRONTEND_DEV_CHANNEL_ID: process.env.DC_FRONTEND_DEV_CHANNEL_ID || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
};

// 啟動時自我檢查
if (!ENV.TG_TOKEN) {
  console.warn("⚠️ 警告：未設定 TG_TOKEN，Telegram 模組將無法運作");
}
