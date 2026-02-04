import fs from "fs/promises";
import path from "path";

export class ConfigLoader {
  public static readonly BASE_PATH =
    "/Users/xuxinjie/Developer/AI-Rules/Global-Config/skills";

  // 獲取所有子資料夾名稱
  static async getAvailableFolders(): Promise<string[]> {
    const entries = await fs.readdir(this.BASE_PATH, { withFileTypes: true });
    return entries
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  }

  // 讀取指定資料夾的所有內容
  static async readFoldersContent(folders: string[]): Promise<string> {
    let combined = "";
    for (const folder of folders) {
      const fullPath = path.join(this.BASE_PATH, folder);
      try {
        const files = await fs.readdir(fullPath);
        combined += `\n[來自守則庫: ${folder}]\n`;
        for (const file of files) {
          if (file.endsWith(".md") || file.endsWith(".txt")) {
            const content = await fs.readFile(
              path.join(fullPath, file),
              "utf-8",
            );
            combined += content + "\n";
          }
        }
      } catch (e) {
        console.warn(`讀取資料夾 ${folder} 失敗`);
      }
    }
    return combined;
  }
}
