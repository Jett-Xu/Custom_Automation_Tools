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
   * 自動掃描並解析所有目錄下的 SKILL.md
   */
  static async loadAll(): Promise<SkillMetadata[]> {
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
      return skills.filter((s): s is SkillMetadata => s !== null);
    } catch (error) {
      console.error("讀取 Skills 目錄失敗:", error);
      return [];
    }
  }
}
