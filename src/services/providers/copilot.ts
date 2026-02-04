import { CopilotClient } from "@github/copilot-sdk";
import { AIProvider, AIIntent } from "../../types/index.js";
import { AGENT_CONFIG } from "../../config/agents.js";

export class CopilotProvider implements AIProvider {
  name = "copilot";
  private client: CopilotClient;

  constructor() {
    this.client = new CopilotClient();
  }

  async analyzeIntent(prompt: string): Promise<AIIntent> {
    // 動態生成 Agent 清單字串
    const agentDescriptions = AGENT_CONFIG.map(
      (a, i) => `${i + 1}. ${a.id}: ${a.description}`,
    ).join("\n");
    try {
      await this.client.start();
      const session = await this.client.createSession({
        model: "gpt-4o",
        systemMessage: {
          content: `你是一個 AI 代理總調度員。請分析使用者的意圖並分派。
          
          當前可用 Agent 清單：
          ${agentDescriptions}
          
          請僅輸出 JSON: {"action": "AGENT_ID", "payload": "內容"}`,
          mode: "replace",
        },
      });

      const response = await session.sendAndWait({ prompt });
      await session.destroy();
      await this.client.stop();

      const rawContent = response?.data.content || "{}";

      // 使用 Regex 確保即便 AI 輸出 Markdown 也能提取 JSON
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as AIIntent;
      }
      throw new Error("Invalid JSON structure");
    } catch (error) {
      console.error("AI 路由失敗，啟動備援判斷:", error);
      // 關鍵字備援邏輯
      if (
        prompt.includes("股票") ||
        prompt.includes("跌") ||
        prompt.includes("漲")
      )
        return { action: "STOCK_AGENT", payload: prompt };
      return { action: "unknown", payload: null };
    }
  }
}
