// src/services/ai/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import { AIService } from "../../types/index.js";
import { ENV } from "../../config/env.js";

export class GeminiAIService implements AIService {
  private genAI: GoogleGenerativeAI;
  private modelName = "gemini-2.5-flash-lite";

  constructor() {
    if (!ENV.GEMINI_API_KEY) {
      console.warn("⚠️ 警告：未設定 GEMINI_API_KEY，AI 呼叫將會失敗。");
    }
    // 初始化 GenAI SDK
    this.genAI = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);
  }

  async ask(prompt: string, systemMessage: string): Promise<string> {
    try {
      // 取得特定模型，並可以傳入 systemMessage (systemInstruction)
      const model = this.genAI.getGenerativeModel({
        model: this.modelName,
        systemInstruction: systemMessage,
      });

      // 產生內容
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();

      return responseText || "AI 產出失敗 (無回傳內容)";
    } catch (error) {
      console.error("Gemini SDK Error:", error);
      return `[AI Error]: ${error instanceof Error ? error.message : "未知錯誤"}`;
    }
  }
}
