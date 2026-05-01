import fs from "fs/promises";
import path from "path";

interface PathCache {
  tree: string;
  timestamp: number;
}

export class PathExtractor {
  /**
   * 更嚴格的 Regex：只匹配常見本機絕對路徑前綴（/Users/, /home/, /opt/ 等）
   * 避免誤匹配 URL 片段（/api/v1/users）或 Express 路由字串
   */
  private static pathRegex =
    /\/(Users|home|opt|srv|workspace|var\/www)\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.~@-]+)+/g;

  // 要忽略的目錄，避免把整個 node_modules 印出來塞爆 Context Window
  private static ignoreDirs = [
    "node_modules", ".git", "dist", "build", "output", "coverage", ".vscode",
  ];

  /**
   * 目錄樹快取（TTL = 5 分鐘）
   * 相同路徑在 5 分鐘內重複詢問時，直接回傳快取，避免重複掃描與 Token 浪費
   */
  private static treeCache = new Map<string, PathCache>();
  private static CACHE_TTL_MS = 5 * 60 * 1000;

  static async enrichPrompt(userPrompt: string): Promise<string> {
    const paths = userPrompt.match(this.pathRegex);

    if (!paths || paths.length === 0) {
      return userPrompt; // 沒有偵測到本機路徑，不處理
    }

    const targetPath = paths[0]; // 取第一個路徑

    try {
      const stats = await fs.stat(targetPath);
      if (!stats.isDirectory()) {
        return userPrompt; // 不是資料夾就不管
      }

      // 檢查快取
      const now = Date.now();
      const cached = this.treeCache.get(targetPath);
      let treeString: string;

      if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
        console.log(`📦 [PathExtractor] 命中快取，跳過掃描: ${targetPath}`);
        treeString = cached.tree;
      } else {
        console.log(`🔍 [PathExtractor] 偵測到本地路徑，正在掃描目錄結構: ${targetPath}`);
        // 深度 3 層：對絕大多數前端/全端專案已足夠，可節省 30~50% Token
        treeString = await this.generateTree(targetPath, 0, 3);
        this.treeCache.set(targetPath, { tree: treeString, timestamp: now });
      }

      const enrichedContext = `
=========================================
[系統自動注入：本地專案掃描報告]
偵測到使用者提供了本地專案路徑：${targetPath}
以下是該專案的目錄結構 (已過濾 node_modules 等雜訊，最大深度 3 層)：

${treeString}
(請務必綜合以上專案結構資訊，執行使用者的原始指令與評估)
=========================================
`;
      return `${userPrompt}\n\n${enrichedContext}`;
    } catch (error) {
      console.warn(`[PathExtractor] 無法讀取路徑 ${targetPath}:`, error);
      return userPrompt; // 讀取失敗默默退回，不中斷流程
    }
  }

  private static async generateTree(
    dir: string,
    depth: number,
    maxDepth: number,
  ): Promise<string> {
    if (depth >= maxDepth) return "";

    let result = "";
    const indent = "  ".repeat(depth);

    try {
      const files = await fs.readdir(dir, { withFileTypes: true });

      // 先排序：資料夾在上面，檔案在下面
      const sortedFiles = files.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const file of sortedFiles) {
        if (this.ignoreDirs.includes(file.name)) continue;

        if (file.isDirectory()) {
          result += `${indent}📁 ${file.name}/\n`;
          result += await this.generateTree(
            path.join(dir, file.name),
            depth + 1,
            maxDepth,
          );
        } else {
          result += `${indent}📄 ${file.name}\n`;
        }
      }
    } catch (e) {
      result += `${indent}(權限不足)\n`;
    }

    return result;
  }

  /** 手動清除目錄樹快取（更新專案結構後可呼叫） */
  static clearCache(): void {
    this.treeCache.clear();
    console.log("[PathExtractor] 快取已清除");
  }
}
