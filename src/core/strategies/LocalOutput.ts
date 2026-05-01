import fs from "fs/promises";
import path from "path";
import { OutputStrategy, OutputContext } from "./OutputStrategy.js";

export class LocalOutput implements OutputStrategy {
  async execute({ content, fileName, subDir = "" }: OutputContext): Promise<string> {
    const finalDir = path.resolve(process.cwd(), "output", subDir);
    await fs.mkdir(finalDir, { recursive: true });
    
    const filePath = path.join(finalDir, fileName);
    await fs.writeFile(filePath, content, "utf-8");

    return `✅ [本地端] 檔案已成功寫入：${filePath}`;
  }
}
