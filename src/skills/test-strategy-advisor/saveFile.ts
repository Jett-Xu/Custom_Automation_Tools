import { SkillFunction } from "../../types/index.js";
import { OutputManager } from "../../core/io/OutputManager.js";

export const execute: SkillFunction = async (rawResponse: string) => {
  try {
    // 移除 LLM 可能加入的 Markdown codeblock 標記
    const cleanJson = rawResponse.replace(/```json/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    
    const date = new Date();
    const timestamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date.getHours().toString().padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}`;
    const fileName = `test_strategy_${timestamp}.md`;

    // 透過基礎建設層 (策略模式) 自動分派儲存邏輯
    return await OutputManager.save({
      content: parsed.content || rawResponse,
      fileName: fileName,
      targetPath: parsed.detectedPath,
      subDir: "frontend/testing"
    });
  } catch (error) {
    console.error("JSON Parsing or Output Error:", error);
    // 降級處理：如果 LLM 回傳的不是合法 JSON，就當作純字串存到本地
    const timestamp = Date.now().toString();
    return await OutputManager.save({
      content: rawResponse,
      fileName: `test_strategy_fallback_${timestamp}.md`,
      subDir: "frontend/testing"
    });
  }
};
