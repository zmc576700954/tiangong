/**
 * BizGraph 自定义错误类型体系
 * 替换所有裸 throw new Error 为语义化错误类型
 */

/** 错误码枚举 */
export const ErrorCode = {
  // 通用
  UNKNOWN: 'UNKNOWN',

  // 数据库
  DB_NOT_INITIALIZED: 'DB_NOT_INITIALIZED',
  DB_INVALID_IDENTIFIER: 'DB_INVALID_IDENTIFIER',
  DB_QUERY_FAILED: 'DB_QUERY_FAILED',

  // IPC
  IPC_ACCESS_DENIED: 'IPC_ACCESS_DENIED',
  IPC_INVALID_ARGUMENT: 'IPC_INVALID_ARGUMENT',
  IPC_RATE_LIMITED: 'IPC_RATE_LIMITED',
  IPC_HANDLER_ERROR: 'IPC_HANDLER_ERROR',

  // Agent / 适配器
  AGENT_ADAPTER_NOT_FOUND: 'AGENT_ADAPTER_NOT_FOUND',
  AGENT_SESSION_NOT_FOUND: 'AGENT_SESSION_NOT_FOUND',
  AGENT_ADAPTER_ERROR: 'AGENT_ADAPTER_ERROR',
  AGENT_PROCESS_ERROR: 'AGENT_PROCESS_ERROR',
  AGENT_SESSION_LIMIT: 'AGENT_SESSION_LIMIT',

  // 范围守卫
  SCOPE_PATH_TRAVERSAL: 'SCOPE_PATH_TRAVERSAL',
  SCOPE_OUT_OF_BOUNDS: 'SCOPE_OUT_OF_BOUNDS',

  // 配置
  SETTINGS_INVALID_FORMAT: 'SETTINGS_INVALID_FORMAT',

  // Git
  GIT_NOT_A_REPO: 'GIT_NOT_A_REPO',
  GIT_OPERATION_FAILED: 'GIT_OPERATION_FAILED',
} as const

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode]

/** 基类 */
export class BizGraphError extends Error {
  readonly code: ErrorCodeType

  constructor(message: string, code: ErrorCodeType = ErrorCode.UNKNOWN) {
    super(message)
    this.name = 'BizGraphError'
    this.code = code
    // 修复原型链（TypeScript 继承 Error 时的已知问题）
    Object.setPrototypeOf(this, BizGraphError.prototype)
  }

  /** 序列化为普通对象，确保自定义属性能通过 Electron IPC 传输 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
    }
  }
}

/** 数据库相关错误 */
export class DatabaseError extends BizGraphError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.DB_QUERY_FAILED) {
    super(message, code)
    this.name = 'DatabaseError'
    Object.setPrototypeOf(this, DatabaseError.prototype)
  }
}

/** IPC 调用错误 */
export class IpcError extends BizGraphError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.IPC_INVALID_ARGUMENT) {
    super(message, code)
    this.name = 'IpcError'
    Object.setPrototypeOf(this, IpcError.prototype)
  }
}

/** Agent 相关错误 */
export class AgentError extends BizGraphError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.AGENT_ADAPTER_ERROR) {
    super(message, code)
    this.name = 'AgentError'
    Object.setPrototypeOf(this, AgentError.prototype)
  }
}

/** 会话不存在 */
export class SessionNotFoundError extends AgentError {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`Session ${sessionId} not found`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
    Object.setPrototypeOf(this, SessionNotFoundError.prototype)
  }

  toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), sessionId: this.sessionId }
  }
}

/** 适配器操作失败 */
export class AdapterError extends AgentError {
  readonly adapterName?: string

  constructor(message: string, adapterName?: string, code: ErrorCodeType = ErrorCode.AGENT_ADAPTER_ERROR) {
    super(message, code)
    this.name = 'AdapterError'
    this.adapterName = adapterName
    Object.setPrototypeOf(this, AdapterError.prototype)
  }

  toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), adapterName: this.adapterName }
  }
}

/** 范围守卫违规 */
export class ScopeGuardError extends BizGraphError {
  constructor(message: string, code: ErrorCodeType = ErrorCode.SCOPE_OUT_OF_BOUNDS) {
    super(message, code)
    this.name = 'ScopeGuardError'
    Object.setPrototypeOf(this, ScopeGuardError.prototype)
  }
}

/** Git 操作错误 */
export class GitError extends BizGraphError {
  readonly repoPath?: string

  constructor(message: string, repoPath?: string, code: ErrorCodeType = ErrorCode.GIT_OPERATION_FAILED) {
    super(message, code)
    this.name = 'GitError'
    this.repoPath = repoPath
    Object.setPrototypeOf(this, GitError.prototype)
  }

  toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), repoPath: this.repoPath }
  }
}
