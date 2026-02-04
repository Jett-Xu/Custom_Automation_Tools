// src/types/index.ts
export interface SkillFunction {
  (content: string): Promise<string>;
}

export interface SkillMetadata {
  folder: string;
  name: string;
  description: string;
  fullContent: string;
}

// src/services/messenger/base.ts
export interface Messenger {
  init(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  onMessage(callback: (chatId: string, text: string) => void): void;
}

// src/services/ai/base.ts
export interface AIService {
  ask(prompt: string, systemMessage: string): Promise<string>;
}
