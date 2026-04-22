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



// src/services/ai/base.ts
export interface AIService {
  ask(prompt: string, systemMessage: string): Promise<string>;
}
