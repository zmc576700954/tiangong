/**
 * Runtime 领域错误。IPC/AgentManager 依赖 code 做 fail-fast 映射。
 */

export type RuntimeErrorCode =
  | 'SESSION_BUSY'
  | 'NODE_BUSY'
  | 'APPROVAL_ARGS_MISMATCH'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_STALE'
  | 'APPROVAL_NOT_OWNED'
  | 'TURN_NOT_FOUND'
  | 'EXECUTOR_CONFIG_INVALID'
  | 'RECOVERY_FAILED'

export class AgentRuntimeError extends Error {
  readonly code: RuntimeErrorCode

  constructor(code: RuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentRuntimeError'
    this.code = code
  }
}

export class SessionBusyError extends AgentRuntimeError {
  constructor(key: string) {
    super('SESSION_BUSY', `SESSION_BUSY: session is busy (lock held): ${key}`)
    this.name = 'SessionBusyError'
  }
}

export class NodeBusyError extends AgentRuntimeError {
  constructor(nodeId: string, branchKey: string) {
    super('NODE_BUSY', `NODE_BUSY: node already has an active turn: ${nodeId} (branch=${branchKey})`)
    this.name = 'NodeBusyError'
  }
}

