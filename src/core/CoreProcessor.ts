import { MessageContext, BotAdapter } from "../services/messenger/botAdapter.js";
import { Orchestrator } from "../agents/orchestrator.js";
import { AIService } from "../types/index.js";

export class CoreProcessor {
  private orchestrator: Orchestrator;
  private aiBrain: AIService;

  constructor(aiBrain: AIService) {
    this.orchestrator = new Orchestrator();
    this.aiBrain = aiBrain;
  }

  async handleMessage(context: MessageContext, adapter: BotAdapter) {
    // 可以在這裡加入一個 loading 提示
    await adapter.sendMessage(context.chatId, "⏳ 正在思考並處理您的請求...");

    try {
      const result = await this.orchestrator.dispatch(context, this.aiBrain);
      await adapter.sendMessage(context.chatId, result);
    } catch (err) {
      console.error("CoreProcessor Error:", err);
      await adapter.sendMessage(context.chatId, "❌ 處理請求時發生錯誤。");
    }
  }
}
