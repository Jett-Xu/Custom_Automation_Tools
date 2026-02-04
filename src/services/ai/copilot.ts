// src/services/ai/copilot.ts
import { CopilotClient } from "@github/copilot-sdk";
import { AIService } from "../../types/index.js";

export class CopilotAIService implements AIService {
  private client: CopilotClient;

  constructor() {
    // CopilotClient 會自動抓取環境中的認證
    this.client = new CopilotClient();
  }

  async ask(prompt: string, systemMessage: string): Promise<string> {
    try {
      await this.client.start();

      const session = await this.client.createSession({
        model: "gpt-4o",
        systemMessage: {
          content: systemMessage,
          mode: "replace",
        },
      });

      const response = await session.sendAndWait({ prompt });
      const result = response?.data.content || "AI 產出失敗";

      await session.destroy();
      await this.client.stop();

      return result;
    } catch (error) {
      console.error("Copilot SDK Error:", error);
      return `[AI Error]: ${error instanceof Error ? error.message : "未知錯誤"}`;
    }
  }
}
