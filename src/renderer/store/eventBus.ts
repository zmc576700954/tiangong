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

export type EventName = (typeof Events)[keyof typeof Events]

/** Event parameter types — maps event names to their handler signatures */
interface EventParamMap {
  [Events.AGENT_STATUS_CHANGE]: [nodeId: string, status: string]
  [Events.GRAPH_CHANGED]: []
  [Events.NODE_SELECTED]: [nodeId: string]
  [Events.THREAD_CREATED]: [threadId: string]
  [Events.THREAD_DELETED]: [threadId: string]
  [Events.NODE_STATUS_REJECTED]: [nodeId: string, from: string, to: string]
  [Events.SESSION_STARTED]: [sessionId: string]
  [Events.SESSION_TERMINATED]: [sessionId: string]
  [Events.SESSION_CRASHED]: [sessionId: string]
  [Events.SESSION_RECOVERED]: [sessionId: string, newSessionId: string]
  [Events.SESSION_RECOVERY_FAILED]: [sessionId: string, reason: string]
  [Events.STREAMING_CHUNK]: [threadId: string, chunk: string]
  [Events.MESSAGE_SENT]: [threadId: string]
  [Events.MESSAGE_FAILED]: [threadId: string, error: string]
  [Events.ADAPTER_HEALTH_CHANGE]: [adapterName: string, status: string]
  [Events.CONFIRMATION_REQUIRED]: [payload: unknown]
  [Events.CONFIRMATION_RESPONDED]: [payload: unknown]
  [Events.GENERATION_PROGRESS]: [payload: unknown]
  [Events.NODE_STATUS_CHANGE]: [nodeId: string, oldStatus: string, newStatus: string]
  [Events.OPEN_ADAPTER_SELECTOR]: []
  [Events.ADAPTER_RECOVERED]: [adapterName: string]
}

type EventHandler<E extends EventName> = E extends keyof EventParamMap
  ? (...args: EventParamMap[E]) => void
  : (...args: unknown[]) => void

class EventBus {
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>()

  /**
   * 订阅事件，返回取消订阅函数
   */
  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    const wrapped = (...args: unknown[]) => (handler as (...args: unknown[]) => void)(...args)
    set.add(wrapped)
    return () => {
      set!.delete(wrapped)
      if (set!.size === 0) this.handlers.delete(event)
    }
  }

  /**
   * 发布事件
   */
  emit<E extends EventName>(event: E, ...args: EventParamMap[E extends keyof EventParamMap ? E : never]): void {
    const set = this.handlers.get(event)
    if (!set) return
    // Copy handlers before iteration to allow safe removal during iteration
    const handlers = Array.from(set)
    for (const handler of handlers) {
      try {
        handler(...args)
      } catch (err) {
        console.warn(`[EventBus] Error in handler for ${event}:`, err)
      }
    }
  }

  /**
   * 移除某事件的所有处理器
   */
  offAll(event: EventName): void {
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
