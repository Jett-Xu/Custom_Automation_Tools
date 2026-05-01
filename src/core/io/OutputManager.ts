import { OutputStrategy, OutputContext } from "../strategies/OutputStrategy.js";
import { LocalOutput } from "../strategies/LocalOutput.js";
import { DesignatedOutput } from "../strategies/DesignatedOutput.js";

export class OutputManager {
  static async save(context: OutputContext): Promise<string> {
    let strategy: OutputStrategy;

    // 如果使用者有給定絕對路徑，就啟動「指定路徑策略」，否則用「本地策略」
    if (context.targetPath && context.targetPath.trim() !== "") {
      strategy = new DesignatedOutput();
    } else {
      strategy = new LocalOutput();
    }

    try {
      return await strategy.execute(context);
    } catch (error) {
      console.error("OutputManager Error:", error);
      throw new Error(`儲存失敗: ${error instanceof Error ? error.message : "未知錯誤"}`);
    }
  }
}
