// src/services/messenger/telegram.ts
import { Telegraf } from "telegraf";
import { Messenger } from "../../types/index.js";

export class TelegramService implements Messenger {
  private bot: Telegraf;

  constructor(token: string) {
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

  onMessage(callback: (chatId: string, text: string) => void) {
    this.bot.on("text", (ctx) => {
      callback(ctx.chat.id.toString(), ctx.message.text);
    });
  }

  async sendMessage(chatId: string, text: string) {
    await this.bot.telegram.sendMessage(chatId, text);
  }
}
