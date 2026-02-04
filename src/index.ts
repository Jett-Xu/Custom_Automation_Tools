import "dotenv/config";
import { ENV } from "./config/env.js";
import Fastify from "fastify";
import { TelegramAdapter } from "./platforms/telegram.js";
import { CopilotProvider } from "./services/providers/copilot.js";
import { FileStorageProvider } from "./services/storage/fileStorage.js";
import { createSkillRegistry } from "./agents/index.js";
import { TaskTracker } from "./services/taskTracker.js";

const fastify = Fastify({ logger: true });

// 1. 初始化
const aiAgent = new CopilotProvider();
const storage = new FileStorageProvider("output");
const skillRegistry = createSkillRegistry(storage);

// 2. 核心調度中心
const orchestrator = async (text: string, chatId: number) => {
  let currentAction = "";
  try {
    const intent = await aiAgent.analyzeIntent(text);
    currentAction = intent.action;
    const skill = skillRegistry[currentAction] || skillRegistry["unknown"];
    const result = await skill(intent.payload);
    await messenger.sendMessage(chatId, result);
  } catch (error: any) {
    const isTimeout =
      error.message.includes("timeout") || error.message.includes("idle");
    if (isTimeout && currentAction && TaskTracker.isRunning(currentAction)) {
      await messenger.sendMessage(
        chatId,
        `⏳ 任務 [${currentAction}] 處理中，請稍候查看結果...`
      );
      return;
    }
    console.error("調度錯誤:", error);
    await messenger.sendMessage(
      chatId,
      `❌ 系統調度失敗: ${error.message || "發生未知錯誤"}`
    );
  }
};

// 3. 啟動平台
if (!ENV.TELEGRAM_TOKEN) throw new Error("TELEGRAM_TOKEN Missing");
const messenger = new TelegramAdapter(ENV.TELEGRAM_TOKEN);
messenger.listen(orchestrator);

const start = async () => {
  try {
    await fastify.listen({ port: Number(ENV.PORT), host: "0.0.0.0" });
    console.log("🚀 AI 代理管理員運行中...");
  } catch (err) {
    process.exit(1);
  }
};
start();
