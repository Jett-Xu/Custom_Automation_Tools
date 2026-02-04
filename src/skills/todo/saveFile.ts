// src/skills/todo/saveFile.ts
import fs from "fs/promises";
import path from "path";
import { SkillFunction } from "../../types/index.js";

export const execute: SkillFunction = async (content: string) => {
  try {
    // 1. 定義存檔路徑為專案根目錄下的 output/todo
    // 使用 process.cwd() 確保路徑從專案根目錄開始計算
    const targetDir = path.resolve(process.cwd(), "output/todo");

    // 2. 自動檢查並建立資料夾 (recursive: true 確保父資料夾也會被建立)
    await fs.mkdir(targetDir, { recursive: true });

    // 3. 產生檔名 (加上時間戳記避免重複)
    const date = new Date();
    const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date.getHours().toString().padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}`;
    const fileName = `todo_${timestamp}.md`;
    const filePath = path.join(targetDir, fileName);

    // 4. 寫入檔案
    await fs.writeFile(filePath, content, "utf-8");

    // 5. 回傳給 Orchestrator 的成功訊息
    return `✅ 任務處理完成！\n📁 存檔路徑：output/todo/${fileName}`;
  } catch (error) {
    console.error("Save file error:", error);
    throw new Error(
      `無法儲存檔案到 output 目錄: ${error instanceof Error ? error.message : "未知錯誤"}`,
    );
  }
};
