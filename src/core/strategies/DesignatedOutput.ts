import fs from "fs/promises";
import path from "path";
import { OutputStrategy, OutputContext } from "./OutputStrategy.js";

export class DesignatedOutput implements OutputStrategy {
  async execute({ content, fileName, targetPath, subDir = "" }: OutputContext): Promise<string> {
    if (!targetPath) throw new Error("必須提供目標路徑");

    // 存到使用者指定的絕對路徑，並在底下建立 output/subDir
    const finalDir = path.resolve(targetPath, "output", subDir);
    await fs.mkdir(finalDir, { recursive: true });
    
    const filePath = path.join(finalDir, fileName);
    await fs.writeFile(filePath, content, "utf-8");

    return `✅ [指定路徑] 檔案已成功寫入目標專案目錄：${filePath}`;
  }
}
