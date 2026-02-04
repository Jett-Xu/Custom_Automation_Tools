export interface AIIntent {
  action: string;
  payload: any;
}

export interface AIProvider {
  name: string;
  // 核心方法：將使用者文字轉化為意圖 (Intent)
  analyzeIntent(prompt: string): Promise<AIIntent>;
}

export type SkillFunction = (payload: any) => Promise<string>;

export interface PlatformAdapter {
  name: string;
  listen(onMessage: (text: string, chatId: number) => Promise<void>): void;
}

export interface StorageProvider {
  name: string;
  save(data: any): Promise<void>;
}
