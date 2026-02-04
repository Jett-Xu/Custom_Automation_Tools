import { Telegraf } from "telegraf";
import { PlatformAdapter } from "../types/index.js";

export class TelegramAdapter implements PlatformAdapter {
  name = "telegram";
  private bot: Telegraf;

  constructor(token: string) {
    this.bot = new Telegraf(token);
  }

  sendMessage(chatId: number, text: string) {
    return this.bot.telegram.sendMessage(chatId, text);
  }

  listen(onMessage: (text: string, chatId: number) => Promise<void>) {
    this.bot.on("text", async (ctx) => {
      try {
        const text = ctx.message.text;
        const cleanText = text.replace(/^[A-Z]+:\s*/i, "").trim();
        const chatId = ctx.chat.id;

        await ctx.reply("⏳ 任務已接收，正在處理中，完成後會通知您。");
        // 非同步執行，不 await
        onMessage(cleanText, chatId);
      } catch (err) {
        console.error("Telegram 監聽層捕捉到錯誤:", err);
        await ctx.reply("⚠️ 抱歉，處理請求時發生系統錯誤，請稍後再試。");
      }
    });

    this.bot.catch((err: any, ctx) => {
      console.error(`Telegraf 捕捉到未處理錯誤: ${ctx.update.update_id}`, err);
    });

    this.bot.launch();
  }
}
