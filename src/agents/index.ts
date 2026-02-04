import { SkillFunction, StorageProvider } from "../types/index.js";
import { stockAgent } from "./stock/index.js";
import { sddAgent } from "./sdd/index.js";
import { todoAgent } from "./todo/index.js"; // 假設你也建立好了

export const createSkillRegistry = (
  storage: StorageProvider,
): Record<string, SkillFunction> => {
  return {
    // 從子模組中引入實作
    SDD_AGENT: sddAgent(storage, "SDD_AGENT"),
    STOCK_AGENT: stockAgent(storage, "STOCK_AGENT"),
    TODO_AGENT: todoAgent(storage, "TODO_AGENT"),

    // Fallback
    unknown: async () => "🤔 找不到對應的專業代理人處理此請求。",
  };
};
