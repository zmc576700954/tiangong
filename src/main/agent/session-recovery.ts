/**
 * SessionRecoveryManager — 会话恢复管理器
 *
 * 当 Agent 会话因异常退出而中断时，尝试根据适配器类型恢复会话。
 * - claude-code 适配器支持 --resume 原生恢复，策略返回原 sessionId
 * - mcp-adapter 等无状态适配器不支持恢复，策略返回 null
 *
 * 恢复由 AgentManager 调用，本模块不主动触发。
 */

import type { AgentOutput } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('session-recovery')

export interface RecoveryContext {
  sessionId: string
  adapterName: string
  projectId?: string
  lastOutputs: AgentOutput[]
  lastMessages?: Array<{ role: string; content: string }>
}

export interface RecoveryStrategy {
  adapterName: string
  canResume: boolean
  resume(context: RecoveryContext): Promise<string | null> // returns new sessionId or null
}

export class SessionRecoveryManager {
  private strategies = new Map<string, RecoveryStrategy>()
  private recoveryAttempts = new Map<string, number>()
  private maxRetries = 3

  constructor() {
    // Register built-in strategies
    this.registerStrategy({
      adapterName: 'claude-code',
      canResume: true,
      resume: async (ctx) => ctx.sessionId, // claude-code uses --resume flag
    })
    this.registerStrategy({
      adapterName: 'mcp-adapter',
      canResume: false,
      resume: async () => null, // MCP adapter creates new session
    })
  }

  registerStrategy(strategy: RecoveryStrategy): void {
    this.strategies.set(strategy.adapterName, strategy)
  }

  async attemptRecovery(context: RecoveryContext): Promise<string | null> {
    const { sessionId, adapterName } = context
    const attempts = this.recoveryAttempts.get(sessionId) ?? 0

    if (attempts >= this.maxRetries) {
      logger.warn(`Max recovery attempts (${this.maxRetries}) reached for session ${sessionId}`)
      return null
    }

    const strategy = this.strategies.get(adapterName)
    if (!strategy) {
      logger.info(`No recovery strategy for adapter ${adapterName}`)
      return null
    }

    this.recoveryAttempts.set(sessionId, attempts + 1)

    try {
      const newSessionId = await strategy.resume(context)
      if (newSessionId) {
        logger.info(`Session ${sessionId} recovered via ${adapterName} strategy (attempt ${attempts + 1})`)
        this.recoveryAttempts.delete(sessionId)
      }
      return newSessionId
    } catch (error) {
      logger.warn(`Recovery failed for session ${sessionId}:`, error)
      return null
    }
  }

  getAttempts(sessionId: string): number {
    return this.recoveryAttempts.get(sessionId) ?? 0
  }

  reset(sessionId: string): void {
    this.recoveryAttempts.delete(sessionId)
  }
}

let _instance: SessionRecoveryManager | null = null

export function getSessionRecoveryManager(): SessionRecoveryManager {
  if (!_instance) _instance = new SessionRecoveryManager()
  return _instance
}
