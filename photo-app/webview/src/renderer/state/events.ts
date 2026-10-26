// ============================================================
// renderer/state/events.ts — 事件总线（发布/订阅）
// 用于 UI 组件间解耦通信
// ============================================================

type EventHandler = (...args: any[]) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach((handler) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`事件处理错误 [${event}]:`, err);
      }
    });
  }

  removeAll(): void {
    this.handlers.clear();
  }
}

export const appEvents = new EventBus();