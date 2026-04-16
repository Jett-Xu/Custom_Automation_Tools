import { AIService } from "../types/index.js";
import { SkillLoader } from "../skills/skillLoader.js";

export class Orchestrator {
  async dispatch(userInput: string, ai: AIService) {
    // 1. 使用 Loader 獲取所有 Skill 資訊
    const skills = await SkillLoader.loadAll();

    if (skills.length === 0) return "系統目前沒有安裝任何技能。";

    // 2. 構建路由指令
    const skillListString = skills
      .map((s) => `- folder_name: ${s.folder} (用途: ${s.description})`)
      .join("\n");
    const routerSystemPrompt = `你是一個專業的任務分配員。
目前可用技能如下：
${skillListString}

請根據使用者的話，判斷最適合的技能，然後並且「只」回傳該技能的 folder_name 字串本身（不要加上任何括號或其他符號）。
若沒有任何匹配的技能，請回傳 "none"。`;

    let selectedFolder = (await ai.ask(userInput, routerSystemPrompt)).trim();
    // 移除 AI 可能偷加的括號、引號或反引號，增加容錯率
    selectedFolder = selectedFolder.replace(/[\[\]\`\'\"]/g, '');

    if (selectedFolder === "none") {
      return "目前的技能庫中沒有適合處理此請求的工具。";
    }

    const targetSkill = skills.find((s) => s.folder === selectedFolder);
    if (!targetSkill) return `找不到對應的技能路徑: ${selectedFolder}`;

    // 3. 執行 AI 產出
    const finalContent = await ai.ask(userInput, targetSkill.fullContent);

    // 4. 動態載入 saveFile.ts
    try {
      const skillModule = await import(
        `../skills/${selectedFolder}/saveFile.ts`
      );
      const resultMessage = await skillModule.execute(finalContent);
      return resultMessage;
    } catch (err) {
      console.error(err);
      return `產出成功但存檔失敗：${err instanceof Error ? err.message : "未知錯誤"}`;
    }
  }
}
