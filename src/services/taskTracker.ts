export class TaskTracker {
  private static activeTasks = new Map<string, string>();

  // 開始任務
  static start(id: string, description: string) {
    this.activeTasks.set(id, description);
  }

  // 結束任務
  static end(id: string) {
    this.activeTasks.delete(id);
  }

  // 檢查是否有特定類型的任務正在跑
  static isRunning(id: string): boolean {
    return this.activeTasks.has(id);
  }
}
