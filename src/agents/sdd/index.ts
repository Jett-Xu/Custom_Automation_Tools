import { SkillFunction, StorageProvider } from "../../types/index.js";
import { CopilotClient } from "@github/copilot-sdk";
import { ConfigLoader } from "../../services/configLoader.js";
import { TaskTracker } from "../../services/taskTracker.js"; // 確保引入追蹤器

export const sddAgent = (
  storage: StorageProvider,
  agentName: string,
): SkillFunction => {
  const client = new CopilotClient();

  return async (payload: any) => {
    // 檢查鎖定狀態，防止 Telegram 重複請求導致的二次執行
    if (TaskTracker.isRunning(agentName)) {
      console.log(`[Lock] ${agentName} 正在忙碌中，忽略重複請求。`);
      return `⏳ 您的 ${agentName} 任務已在處理中，請勿重複提交，稍後將完成生成。`;
    }

    // 沒在跑才開始
    TaskTracker.start(agentName, `執行中: ${payload}`);

    try {
      await client.start();

      // --- 第一階段：讓 AI 決定要讀哪些資料夾 ---
      const availableFolders = await ConfigLoader.getAvailableFolders();

      const routerSession = await client.createSession({
        model: "gpt-4o",
        systemMessage: {
          content: `你是一個文件庫管理員。現在有以下守則資料夾：\n${availableFolders.join(", ")}
          
          請根據使用者的需求，回傳一個 JSON 陣列，包含應該讀取的資料夾名稱。
          範例：["frontend-design", "project-architecture"]`,
          mode: "replace",
        },
      });

      const routerResponse = await routerSession.sendAndWait({
        prompt: payload,
      });
      const jsonMatch = routerResponse?.data.content.match(/\[.*\]/s);
      const selectedFolders: string[] = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : [];
      await routerSession.destroy();

      // --- 第二階段：讀取選定的內容並生成 SDD ---
      const rulesContent =
        await ConfigLoader.readFoldersContent(selectedFolders);

      const workerSession = await client.createSession({
        model: "gpt-4o",
        systemMessage: {
          content: `你是一個資深架構師。
          參考以下守則：\n${rulesContent}
          
          任務：根據使用者的需求，直接撰寫一份完整的 SDD 文件。
          
          ⚠️ 重要指令：
          1. 不要向使用者提問，直接根據你的專業與「全域守則」進行設計。
          2. 如果使用者需求模糊，請自行根據守則中的技術棧 (例如 Vue 3, Tailwind) 做出最佳實踐。
          3. 輸出格式必須是 Markdown，且內容必須包含：需求分析、資料結構、組件規劃、實作步驟。
          4. 嚴禁回覆「我需要確認需求」或「請告訴我你的偏好」之類的廢話。`,
          mode: "replace",
        },
      });

      // 這裡是耗時最久的地方，通常會在這裡超時
      const finalResponse = await workerSession.sendAndWait({
        prompt: payload,
      });
      const sddResult = finalResponse?.data.content || "生成失敗";

      await workerSession.destroy();
      await client.stop();

      // 存檔邏輯
      const fileName = `SDD_${Date.now()}.md`;
      await storage.save({ fileName, content: sddResult });

      return `✅ 參考了 [${selectedFolders.join(", ")}]，SDD 已生成並存至 output/${fileName}`;
    } catch (error) {
      // 這裡記錄錯誤，但真正的超時判斷會交給 index.ts 的 orchestrator
      console.error("SDD Agent 內部錯誤:", error);
      throw error;
    } finally {
      // 【關鍵】無論如何都要結束追蹤，否則狀態會永遠卡在「執行中」
      TaskTracker.end(agentName);
    }
  };
};
