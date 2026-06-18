/**
 * 渲染进程事件总线
 *
 * 解耦 Store 间的直接引用。例如 agentStore 不再需要直接 import graphStore，
 * 而是通过事件总线发布/订阅跨 Store 状态变更。
 *
 * 使用场景：
 * - agentStatusChange: Agent 状态变更 → graphStore 更新节点状态
 * - graphChanged: 图谱结构变更 → agentStore 刷新关联信息
 * - nodeSelected: 节点选中 → 其他面板响应
 */

type EventHandler = (...args: any[]) => void

class EventBus {
  private handlers = new Map<string, Set<EventHandler>>()

  /**
   * 订阅事件，返回取消订阅函数
   */
  on(event: string, handler: EventHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) this.handlers.delete(event)
    }
  }

  /**
   * 发布事件
   */
  emit(event: string, ...args: any[]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(...args)
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${event}":`, err)
      }
    }
  }

  /**
   * 移除某事件的所有处理器
   */
  offAll(event: string): void {
    this.handlers.delete(event)
  }

  /**
   * 清理所有事件（用于热重载或 Store 重置）
   */
  clear(): void {
    this.handlers.clear()
  }
}

/** 全局单例事件总线 */
export const eventBus = new EventBus()

/** 预定义事件名常量 */
export const Events = {
  AGENT_STATUS_CHANGE: 'agent:statusChange',
  GRAPH_CHANGED: 'graph:changed',
  NODE_SELECTED: 'node:selected',
  THREAD_CREATED: 'thread:created',
  THREAD_DELETED: 'thread:deleted',
  NODE_STATUS_REJECTED: 'node:statusRejected',
  // Chat会话状态管理新增事件
  SESSION_STARTED: 'session:started',
  SESSION_TERMINATED: 'session:terminated',
  SESSION_CRASHED: 'session:crashed',
  SESSION_RECOVERED: 'session:recovered',
  SESSION_RECOVERY_FAILED: 'session:recoveryFailed',
  STREAMING_CHUNK: 'streaming:chunk',
  MESSAGE_SENT: 'message:sent',
  MESSAGE_FAILED: 'message:failed',
  ADAPTER_HEALTH_CHANGE: 'adapter:healthChange',
  CONFIRMATION_REQUIRED: 'confirmation:required',
  CONFIRMATION_RESPONDED: 'confirmation:responded',
  GENERATION_PROGRESS: 'generation:progress',
  NODE_STATUS_CHANGE: 'node:statusChange',
  OPEN_ADAPTER_SELECTOR: 'adapter:openSelector',
  ADAPTER_RECOVERED: 'adapter:recovered',
} as const
