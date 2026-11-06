/**
 * B1：会话级徽标刷新触发条件。
 *
 * 之前的 effect 只依赖 currentSessionId，同会话 turn 结束后不会重取，
 * 必须切换会话才刷新。这里把「turn 真正收口」的事件显式列出来，
 * 由 AgentChatPanel 订阅 agent:onEvent / agent:onApprovalResolved 后重取。
 */

const SESSION_SETTLED_EVENTS = new Set([
  'run.completed',
  'run.failed',
  'run.interrupted',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'approval.resolved',
  'process.reclaimed',
  'error',
])

export function shouldRefreshSessionState(eventType: string | undefined): boolean {
  if (!eventType) return false
  return SESSION_SETTLED_EVENTS.has(eventType)
}
