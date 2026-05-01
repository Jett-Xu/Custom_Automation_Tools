export interface OutputContext {
  content: string;            // LLM 產出的內容
  fileName: string;           // 預期存檔的檔名
  targetPath?: string;        // 使用者指定的外部路徑 (可選)
  subDir?: string;            // 技能的子分類 (例如: frontend/testing)
}

export interface OutputStrategy {
  execute(context: OutputContext): Promise<string>;
}
