// src/skills/architect/saveFile.ts
import fs from "fs/promises";
import path from "path";
import { SkillFunction } from "../../types/index.js";

export const execute: SkillFunction = async (content: string) => {
  try {
    const targetDir = path.resolve(process.cwd(), "output/architect");
    await fs.mkdir(targetDir, { recursive: true });

    const date = new Date();
    const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date.getHours().toString().padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}`;
    const fileName = `System_Design_${timestamp}.md`;
    const filePath = path.join(targetDir, fileName);

    await fs.writeFile(filePath, content, "utf-8");

    return `✅ 系統規劃完成！\n📁 存檔路徑：output/architect/${fileName}`;
  } catch (error) {
    console.error("Save file error:", error);
    throw new Error(`無法儲存檔案到 output 目錄: ${error instanceof Error ? error.message : "未知錯誤"}`);
  }
};
