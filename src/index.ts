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

const start = async () => {
  try {
    if (ENV.TG_TOKEN) {
      const tgBot = new TelegramAdapter(ENV.TG_TOKEN);
      tgBot.onMessage(async (context) => {
        await coreProcessor.handleMessage(context, tgBot);
      });
      await tgBot.init();
    } else {
      console.warn("⚠️ 警告：未設定 TG_TOKEN，Telegram 模組將無法運作");
    }

    if (ENV.DC_TOKEN) {
      const dcBot = new DiscordAdapter(ENV.DC_TOKEN);
      dcBot.onMessage(async (context) => {
        await coreProcessor.handleMessage(context, dcBot);
      });
      await dcBot.init();
    } else {
      console.warn("⚠️ 警告：未設定 DC_TOKEN，Discord 模組將無法運作");
    }

    await fastify.listen({ port: parseInt(ENV.PORT) });
    console.log(`Agent Server 運行中，Port: ${ENV.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
