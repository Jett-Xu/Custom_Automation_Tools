import { SkillFunction, StorageProvider } from "../../types/index.js";

export const todoAgent = (
  storage: StorageProvider,
  agentName: string,
): SkillFunction => {
  return async (payload: any) => {
    await storage.save({ type: "TODO_ITEM", content: payload });
    return `✅ [Todo 任務代理] 已為您記錄：\n${payload}`;
  };
};
