import { AIService } from "../types/index.js";
import { SkillLoader } from "../skills/skillLoader.js";
import { MessageContext } from "../services/messenger/botAdapter.js";

export class Orchestrator {
  async dispatch(context: MessageContext, ai: AIService) {
    // 1. 使用 Loader 獲取所有 Skill 資訊（已快取，不重複讀磁碟）
    const skills = await SkillLoader.loadAll();

    if (skills.length === 0) return "系統目前沒有安裝任何技能。";

    // 前端開發模式篩選
    let availableSkills = skills;
    if (context.isFrontendDevMode) {
      const frontendKeywords = [
        "frontend", "react", "vue", "html", "css", "javascript", "ui", "component",
      ];
      // 測試相關 Skill 一律保留，不受前端關鍵字篩選排除
      const testKeywords = ["test", "spec", "qa", "testing"];

      const frontendSkills = skills.filter(
        (s) =>
          frontendKeywords.some(
            (kw) =>
              s.folder.toLowerCase().includes(kw) ||
              s.description.toLowerCase().includes(kw),
          ) ||
          testKeywords.some((kw) => s.folder.toLowerCase().includes(kw)),
      );

      if (frontendSkills.length > 0) {
        availableSkills = frontendSkills;
      }
    }

    // 2. 構建路由指令
    const skillListString = availableSkills
      .map((s) => `- folder_name: ${s.folder} (用途: ${s.description})`)
      .join("\n");

    const modePrompt = context.isFrontendDevMode
      ? "目前為「前端開發模式」，請優先選用與前端相關的技能。\n"
      : "";

    const routerSystemPrompt = `你是一個專業的任務分配員。
${modePrompt}目前可用技能如下：
${skillListString}

請根據使用者的話，判斷最適合處理的技能。
你可以回傳一個，或者如果該需求是一個「大型專案」需要經過完整的生命週期（例如：規劃 -> 拆解 -> 執行），請使用逗號分隔回傳多個技能以形成工作流（Pipeline）。
例如：architect,task-planner,executor
請「只」回傳技能的 folder_name 字串本身，不要有其他廢話或符號。
若沒有任何匹配的技能，請回傳 "none"。`;

    /** 解析 AI 路由結果，清除多餘符號並分割 */
    const parseRoute = (raw: string): string[] =>
      raw
        .replace(/[\[\]`'"]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    // 3. 第一次路由
    let aiResponse = (await ai.ask(context.text, routerSystemPrompt)).trim();
    let selectedFolders = parseRoute(aiResponse);

    // 若路由結果中沒有任何有效 Skill，自動重試一次
    const hasValidFolder = selectedFolders.some(
      (f) => f === "none" || skills.find((s) => s.folder === f),
    );
    if (!hasValidFolder || selectedFolders.length === 0) {
      console.warn(
        `[Orchestrator] 路由結果無效 ("${aiResponse}")，正在重試...`,
      );
      aiResponse = (await ai.ask(context.text, routerSystemPrompt)).trim();
      selectedFolders = parseRoute(aiResponse);
    }

    if (selectedFolders[0] === "none" || selectedFolders.length === 0) {
      return "目前的技能庫中沒有適合處理此請求的工具。";
    }

    let currentInput = context.text;
    let finalResultMessage = "執行報告：\n";

    for (let i = 0; i < selectedFolders.length; i++) {
      const folder = selectedFolders[i];
      const targetSkill = skills.find((s) => s.folder === folder);

      if (!targetSkill) {
        finalResultMessage += `\n⚠️ 找不到對應的技能路徑: ${folder}`;
        continue;
      }

      // 4. 執行 AI 產出
      // 若是 Pipeline 的後續任務，則帶入前一個任務的產出
      const promptToAI =
        i === 0
          ? context.text
          : `這是使用者的原始需求：\n${context.text}\n\n這是前置步驟的產出結果，請基於此結果繼續你的工作：\n${currentInput}`;

      const stepOutput = await ai.ask(promptToAI, targetSkill.fullContent);

      // 5. 動態載入 saveFile.ts 進行存檔
      try {
        const skillModule = await import(`../skills/${folder}/saveFile.ts`);

        // 型別保護：確保 execute 是合法的函式，避免 Runtime 噴出難以追蹤的錯誤
        if (typeof skillModule.execute !== "function") {
          throw new Error(
            `技能 "${folder}" 的 saveFile.ts 缺少有效的 execute 函式，請確認匯出格式正確。`,
          );
        }

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
