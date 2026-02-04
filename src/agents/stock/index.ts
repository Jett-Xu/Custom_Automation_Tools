import { SkillFunction, StorageProvider } from "../../types/index.js";

export const stockAgent = (
  storage: StorageProvider,
  agentName: string,
): SkillFunction => {
  return async (payload: any) => {
    // 這裡可以執行複雜的邏輯，例如：
    // const data = await financeApi.get(payload);

    // await storage.save({ type: "STOCK_QUERY", content: payload });

    return `📈 [股票分析代理] 正在深入分析 "${payload}" 的即時市場走勢與成交量...`;
  };
};
