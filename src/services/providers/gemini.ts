import { AIProvider, AIIntent } from "../../types/index.js";

export class GeminiProvider implements AIProvider {
  name = "gemini";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyzeIntent(prompt: string): Promise<AIIntent> {
    // 這裡應呼叫 Gemini API (fetch 或 SDK)
    // 範例 Prompt：請分析以下需求並回傳 JSON { "action": "...", "payload": "..." }
    console.log(`[Gemini] 正在分析意圖: ${prompt}`);

    // 模擬 AI 辨識結果
    if (prompt.includes("todolist")) {
      return { action: "create_todo", payload: prompt };
    }
    return { action: "unknown", payload: null };
  }
}
