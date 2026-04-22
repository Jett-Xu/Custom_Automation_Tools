export interface MessageContext {
  chatId: string;
  text: string;
  platform: 'telegram' | 'discord';
  isFrontendDevMode: boolean;
}

export abstract class BotAdapter {
  abstract init(): Promise<void>;
  abstract sendMessage(chatId: string, text: string): Promise<void>;
  abstract sendFiles(chatId: string, files: Buffer[]): Promise<void>;
  abstract onMessage(callback: (context: MessageContext) => void): void;
}
