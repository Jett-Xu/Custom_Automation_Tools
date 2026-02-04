// src/config/env.ts
import * as dotenv from "dotenv";
import path from "path";

// 確保讀取到專案根目錄的 .env
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
export const ENV = {
  PORT: process.env.PORT || "3000",
  TG_TOKEN: process.env.TG_TOKEN || "",
  GITHUB_COPILOT_TOKEN: process.env.GITHUB_COPILOT_TOKEN || "",
};

// 啟動時自我檢查
if (!ENV.TG_TOKEN) {
  console.warn("⚠️ 警告：未設定 TG_TOKEN，Telegram 模組將無法運作");
}
