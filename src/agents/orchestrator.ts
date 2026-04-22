import { AIService } from "../types/index.js";
import { SkillLoader } from "../skills/skillLoader.js";
import { MessageContext } from "../services/messenger/botAdapter.js";

export class Orchestrator {
  async dispatch(context: MessageContext, ai: AIService) {
    // 1. 使用 Loader 獲取所有 Skill 資訊
    const skills = await SkillLoader.loadAll();

    if (skills.length === 0) return "系統目前沒有安裝任何技能。";

    // 優先前端開發模式邏輯
    let availableSkills = skills;
    if (context.isFrontendDevMode) {
      const frontendKeywords = ['frontend', 'react', 'vue', 'html', 'css', 'javascript', 'ui', 'component'];
      const frontendSkills = skills.filter(s => 
        frontendKeywords.some(kw => 
          s.folder.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)
        )
      );
      
      if (frontendSkills.length > 0) {
         availableSkills = frontendSkills;
      }
    }

    // 2. 構建路由指令
    const skillListString = availableSkills
      .map((s) => `- folder_name: ${s.folder} (用途: ${s.description})`)
      .join("\n");

    const modePrompt = context.isFrontendDevMode ? "目前為「前端開發模式」，請優先選用與前端相關的技能。\n" : "";

    const routerSystemPrompt = `你是一個專業的任務分配員。
${modePrompt}目前可用技能如下：
${skillListString}

請根據使用者的話，判斷最適合處理的技能。
你可以回傳一個，或者如果該需求是一個「大型專案」需要經過完整的生命週期（例如：規劃 -> 拆解 -> 執行），請使用逗號分隔回傳多個技能以形成工作流（Pipeline）。
例如：architect,task-planner,executor
請「只」回傳技能的 folder_name 字串本身，不要有其他廢話或符號。
若沒有任何匹配的技能，請回傳 "none"。`;

    let aiResponse = (await ai.ask(context.text, routerSystemPrompt)).trim();
    aiResponse = aiResponse.replace(/[\[\]\`\'\"]/g, ''); // 移除 AI 可能偷加的符號

    if (aiResponse === "none") {
      return "目前的技能庫中沒有適合處理此請求的工具。";
    }

    const selectedFolders = aiResponse.split(',').map(s => s.trim());
    let currentInput = context.text;
    let finalResultMessage = "執行報告：\n";

    for (let i = 0; i < selectedFolders.length; i++) {
      const folder = selectedFolders[i];
      const targetSkill = skills.find((s) => s.folder === folder);
      
      if (!targetSkill) {
        finalResultMessage += `\n⚠️ 找不到對應的技能路徑: ${folder}`;
        continue;
      }

      // 3. 執行 AI 產出
      // 若是 Pipeline 的後續任務，則帶入前一個任務的產出
      const promptToAI = i === 0 
        ? context.text 
        : `這是使用者的原始需求：\n${context.text}\n\n這是前置步驟的產出結果，請基於此結果繼續你的工作：\n${currentInput}`;
        
      const stepOutput = await ai.ask(promptToAI, targetSkill.fullContent);

      // 4. 動態載入 saveFile.ts 進行存檔
      try {
        const skillModule = await import(`../skills/${folder}/saveFile.ts`);
        const resultMessage = await skillModule.execute(stepOutput);
        finalResultMessage += `\n[步驟 ${i + 1} - ${folder}] ${resultMessage}`;
        
        // 將本次的完整輸出，作為下一個 Agent 的輸入
        currentInput = stepOutput;
      } catch (err) {
        console.error(err);
        finalResultMessage += `\n[步驟 ${i + 1} - ${folder}] 產出成功但存檔失敗：${err instanceof Error ? err.message : "未知錯誤"}`;
      }
    }

    return finalResultMessage;
  }
}

