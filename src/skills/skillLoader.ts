import fs from "fs/promises";
import path from "path";

export interface SkillMetadata {
  folder: string;
  name: string;
  description: string;
  fullContent: string;
}

export class SkillLoader {
  private static skillsDir = path.join(process.cwd(), "src/skills");

  /**
   * 記憶體快取：啟動後首次 loadAll() 時掃描並快取，後續請求直接回傳
   * 重啟服務後快取自動清除；新增/修改 Skill 後請呼叫 clearCache() 或重啟
   */
  private static cache: SkillMetadata[] | null = null;

  /**
   * 自動掃描並解析所有目錄下的 SKILL.md
   * 結果快取至記憶體，避免每次請求重複讀取磁碟
   */
  static async loadAll(): Promise<SkillMetadata[]> {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });

      const skillFolders = entries
        .filter((d) => d.isDirectory() && d.name !== "utils") // 排除輔助工具夾
        .map((d) => d.name);

      const skills = await Promise.all(
        skillFolders.map(async (folder) => {
          const filePath = path.join(this.skillsDir, folder, "SKILL.md");

          try {
            const content = await fs.readFile(filePath, "utf-8");

            // 嚴謹解析 YAML-like Frontmatter
            const nameMatch = content.match(/name:\s*(.*)/);
            const descMatch = content.match(/description:\s*(.*)/);

            return {
              folder,
              name: nameMatch ? nameMatch[1].trim() : folder,
              description: descMatch ? descMatch[1].trim() : "無描述",
              fullContent: content,
            };
          } catch (e) {
            console.error(`無法讀取 ${folder} 的 SKILL.md`, e);
            return null;
          }
        }),
      );

      // 過濾掉讀取失敗的
      this.cache = skills.filter((s): s is SkillMetadata => s !== null);
      console.log(`✅ [SkillLoader] 已載入並快取 ${this.cache.length} 個技能`);
      return this.cache;
    } catch (error) {
      console.error("讀取 Skills 目錄失敗:", error);
      return [];
    }
  }

  /**
   * 強制清除快取，下次 loadAll() 時重新掃描磁碟
   * 使用時機：新增、修改或刪除 Skill 後，不重啟服務即可熱重載
   */
  static clearCache(): void {
    this.cache = null;
    console.log("[SkillLoader] 快取已清除，下次請求將重新掃描 Skills");
  }
}
