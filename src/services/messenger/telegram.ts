// src/services/messenger/telegram.ts
import { Telegraf } from "telegraf";
import { BotAdapter, MessageContext } from "./botAdapter.js";

export class TelegramAdapter extends BotAdapter {
  private bot: Telegraf;

  constructor(token: string) {
    super();
    this.bot = new Telegraf(token);
  }

  async init() {
    this.bot.launch();
    console.log("🚀 Telegram Bot 服務已啟動");

    // 偵測錯誤
    this.bot.catch((err) => {
      console.error("Telegraf Error:", err);
    });
  }

  onMessage(callback: (context: MessageContext) => void) {
    this.bot.on("text", (ctx) => {
      callback({
        chatId: ctx.chat.id.toString(),
        text: ctx.message.text,
        platform: 'telegram',
        isFrontendDevMode: false
      });
    });
  }

  async sendMessage(chatId: string, text: string) {
    await this.bot.telegram.sendMessage(chatId, text);
  }

  async sendFiles(chatId: string, files: Buffer[]) {
    for (const file of files) {
      await this.bot.telegram.sendDocument(chatId, { source: file, filename: 'file' });
    }
  }
}
