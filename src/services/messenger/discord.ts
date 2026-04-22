import { Client, GatewayIntentBits, Message, AttachmentBuilder } from "discord.js";
import { BotAdapter, MessageContext } from "./botAdapter.js";
import { ENV } from "../../config/env.js";

export class DiscordAdapter extends BotAdapter {
  private client: Client;
  private token: string;

  constructor(token: string) {
    super();
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async init() {
    this.client.once("ready", () => {
      console.log(`🚀 Discord Bot 服務已啟動, 登入為 ${this.client.user?.tag}`);
    });

    this.client.on("error", (err) => {
      console.error("Discord Error:", err);
    });

    await this.client.login(this.token);
  }

  onMessage(callback: (context: MessageContext) => void) {
    this.client.on("messageCreate", (message: Message) => {
      if (message.author.bot) return;
      
      const isFrontendDevMode = ENV.DC_FRONTEND_DEV_CHANNEL_ID ? message.channelId === ENV.DC_FRONTEND_DEV_CHANNEL_ID : false;
      
      callback({
        chatId: message.channelId,
        text: message.content,
        platform: 'discord',
        isFrontendDevMode
      });
    });
  }

  async sendMessage(chatId: string, text: string) {
    const channel = await this.client.channels.fetch(chatId);
    if (channel && channel.isTextBased() && "send" in channel) {
      await channel.send(text);
    }
  }

  async sendFiles(chatId: string, files: Buffer[]) {
    const channel = await this.client.channels.fetch(chatId);
    if (channel && channel.isTextBased() && "send" in channel) {
      const attachments = files.map((file, i) => new AttachmentBuilder(file, { name: `file-${i}` }));
      await channel.send({ files: attachments });
    }
  }
}
