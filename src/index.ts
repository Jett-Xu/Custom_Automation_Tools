// src/index.ts
import Fastify from "fastify";
import { ENV } from "./config/env.js";
import { TelegramAdapter } from "./services/messenger/telegram.js";
import { DiscordAdapter } from "./services/messenger/discord.js";
import { GeminiAIService } from "./services/ai/gemini.js";
import { CoreProcessor } from "./core/CoreProcessor.js";

const fastify = Fastify({ logger: true });

const aiBrain = new GeminiAIService();
const coreProcessor = new CoreProcessor(aiBrain);

// 健康檢查端點：確認服務正常運行
fastify.get("/health", async () => {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  };
});

const start = async () => {
  try {
    if (ENV.TG_TOKEN) {
      const tgBot = new TelegramAdapter(ENV.TG_TOKEN);
      tgBot.onMessage(async (context) => {
        await coreProcessor.handleMessage(context, tgBot);
      });
      await tgBot.init();
    }

    if (ENV.DC_TOKEN) {
      const dcBot = new DiscordAdapter(ENV.DC_TOKEN);
      dcBot.onMessage(async (context) => {
        await coreProcessor.handleMessage(context, dcBot);
      });
      await dcBot.init();
    }

    await fastify.listen({ port: parseInt(ENV.PORT) });
    console.log(`Agent Server 運行中，Port: ${ENV.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
