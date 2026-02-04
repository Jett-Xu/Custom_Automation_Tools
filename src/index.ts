// src/index.ts
import Fastify from "fastify";
import { ENV } from "./config/env.js";
import { TelegramService } from "./services/messenger/telegram.js";
import { CopilotAIService } from "./services/ai/copilot.js";
import { Orchestrator } from "./agents/orchestrator.js";

const fastify = Fastify({ logger: true });

// 初始化模組
const messenger = new TelegramService(ENV.TG_TOKEN);
const aiBrain = new CopilotAIService();
const manager = new Orchestrator();

// 監聽訊息邏輯
messenger.onMessage(async (chatId, text) => {
  // 可以在這裡加入一個 loading 提示
  await messenger.sendMessage(chatId, "⏳ 正在思考並處理您的請求...");

  const result = await manager.dispatch(text, aiBrain);
  await messenger.sendMessage(chatId, result);
});

const start = async () => {
  try {
    await messenger.init();
    await fastify.listen({ port: parseInt(ENV.PORT) });
    console.log(`Agent Server 運行中，Port: ${ENV.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
