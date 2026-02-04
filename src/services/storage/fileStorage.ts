import fs from "fs/promises";
import path from "path";
import { StorageProvider } from "../../types/index.js";

export class FileStorageProvider implements StorageProvider {
  name = "file_system";
  private outputPath: string;

  constructor(folderName: string = "output") {
    this.outputPath = path.resolve(process.cwd(), folderName);
  }

  async save(data: any): Promise<void> {
    // 確保資料夾存在
    await fs.mkdir(this.outputPath, { recursive: true });

    // 檔名使用時間戳記
    const fileName = `task_${Date.now()}.json`;
    const filePath = path.join(this.outputPath, fileName);

    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    console.log(`[Storage] 資料已存至: ${filePath}`);
  }
}
