/**
 * SessionRecoveryManager — 会话恢复管理器
 *
 * 当 Agent 会话因异常退出而中断时，尝试根据适配器类型恢复会话。
 * - claude-code 适配器支持 --resume 原生恢复，策略返回原 sessionId
 * - mcp-adapter 等无状态适配器通过注入上下文创建新会话
 *
 * 恢复由 AgentManager 调用，本模块不主动触发。
 */

import type { AgentOutput } from '@shared/types'
import { BrowserWindow } from 'electron'
import { createLogger } from '../shared/logger'

const logger = createLogger('session-recovery')

export interface RecoveryContext {
  sessionId: string
  adapterName: string
  projectId?: string
  lastOutputs: AgentOutput[]
  lastMessages?: Array<{ role: string; content: string }>
  threadId?: string
}

export interface RecoveryStrategy {
  adapterName: string
  canResume: boolean
  resume(context: RecoveryContext): Promise<string | null> // returns new sessionId or null
}

export interface RecoveryEvent {
  type: 'SESSION_RECOVERED' | 'SESSION_RECOVERY_FAILED'
  sessionId: string
  newSessionId?: string
  reason?: string
  threadId?: string
}

export class SessionRecoveryManager {
  private strategies = new Map<string, RecoveryStrategy>()
  private recoveryAttempts = new Map<string, number>()
  private recoveryAttemptTimestamps = new Map<string, number>()
  private maxRetries = 3

  constructor() {
    // Register built-in strategies
    this.registerStrategy({
      adapterName: 'claude-code',
      canResume: true,
      resume: async (ctx) => {
        // Claude Code supports --resume <sessionId> natively.
        // Build a context restoration hint from the last 3 messages.
        const lastMessages = ctx.lastMessages?.slice(-3) ?? []
        if (lastMessages.length > 0) {
          const hint = lastMessages
            .map((m) => `- ${m.role}: ${m.content.slice(0, 200)}`)
            .join('\n')
          logger.info(
            `Claude Code resume with context hint for session ${ctx.sessionId}:\n${hint}`,
          )
        }
        // Return the same sessionId — the caller (AgentManager) will pass
        // resumeSessionId in AgentSessionConfig so the adapter adds --resume.
        return ctx.sessionId
      },
    })
    this.registerStrategy({
      adapterName: 'mcp-adapter',
      canResume: false,
      resume: async (ctx) => {
        // MCP adapter is stateless — create a new session and inject previous
        // context as the first message.
        const lastMessages = ctx.lastMessages?.slice(-3) ?? []
        if (lastMessages.length === 0) {
          logger.info('MCP adapter recovery: no previous messages to inject')
          return null
        }
        const contextBlock = [
          '[Previous session context]',
          'Last 3 messages:',
          ...lastMessages.map((m) => `- ${m.role}: ${m.content}`),
          'Please continue from where we left off.',
        ].join('\n')

        // We return a special marker that the caller can use to inject context.
        // The actual session creation happens in AgentManager.startSession,
        // so we store the context injection text and signal a new session is needed.
        logger.info(
          `MCP adapter recovery: injecting context for session ${ctx.sessionId}`,
        )
        // Store the context block so AgentManager can inject it as contextSummary
        this._pendingContextInjections.set(ctx.sessionId, contextBlock)
        // Return null to signal "create new session" — AgentManager will
        // use the pending context injection.
        return null
      },
    })
  }

  /** Context text to inject on next session creation (set by MCP adapter strategy) */
  private _pendingContextInjections = new Map<string, string>()

  /** Consume and clear the pending context injection text */
  consumePendingContext(sessionId: string): string | null {
    const ctx = this._pendingContextInjections.get(sessionId)
    this._pendingContextInjections.delete(sessionId)
    return ctx ?? null
  }

  registerStrategy(strategy: RecoveryStrategy): void {
    this.strategies.set(strategy.adapterName, strategy)
  }

  async attemptRecovery(context: RecoveryContext): Promise<string | null> {
    // Periodic cleanup: remove stale recovery attempts older than 1 hour
    const now = Date.now()
    for (const [key, val] of this.recoveryAttemptTimestamps) {
      if (now - val > 3600000) { // 1 hour
        this.recoveryAttempts.delete(key)
        this.recoveryAttemptTimestamps.delete(key)
      }
    }

    const { sessionId, adapterName } = context
    const attempts = this.recoveryAttempts.get(sessionId) ?? 0

    if (attempts >= this.maxRetries) {
      logger.warn(`Max recovery attempts (${this.maxRetries}) reached for session ${sessionId}`)
      this._notifyRenderer({
        type: 'SESSION_RECOVERY_FAILED',
        sessionId,
        reason: `Max recovery attempts (${this.maxRetries}) exceeded`,
        threadId: context.threadId,
      })
      return null
    }

    const strategy = this.strategies.get(adapterName)
    if (!strategy) {
      logger.info(`No recovery strategy for adapter ${adapterName}`)
      return null
    }

    this.recoveryAttempts.set(sessionId, attempts + 1)
    this.recoveryAttemptTimestamps.set(sessionId, Date.now())

    try {
      const newSessionId = await strategy.resume(context)
      if (newSessionId) {
        logger.info(`Session ${sessionId} recovered via ${adapterName} strategy (attempt ${attempts + 1})`)
        this.recoveryAttempts.delete(sessionId)
        this._notifyRenderer({
          type: 'SESSION_RECOVERED',
          sessionId,
          newSessionId,
          threadId: context.threadId,
        })
      } else if (this._pendingContextInjections.has(context.sessionId)) {
        // MCP adapter case: new session needed with context injection
        logger.info(`Session ${sessionId} requires new session with context injection via ${adapterName} strategy (attempt ${attempts + 1})`)
        this.recoveryAttempts.delete(sessionId)
        this._notifyRenderer({
          type: 'SESSION_RECOVERED',
          sessionId,
          newSessionId: '__new_session__',
          threadId: context.threadId,
        })
      } else if (attempts + 1 >= this.maxRetries) {
        // Final attempt failed
        this._notifyRenderer({
          type: 'SESSION_RECOVERY_FAILED',
          sessionId,
          reason: `Recovery strategy returned null after ${attempts + 1} attempts`,
          threadId: context.threadId,
        })
      }
      return newSessionId
    } catch (error) {
      logger.warn(`Recovery failed for session ${sessionId}:`, error)
      if (attempts + 1 >= this.maxRetries) {
        this._notifyRenderer({
          type: 'SESSION_RECOVERY_FAILED',
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
          threadId: context.threadId,
        })
      }
      return null
    }
  }

  getAttempts(sessionId: string): number {
    return this.recoveryAttempts.get(sessionId) ?? 0
  }

  reset(sessionId: string): void {
    this.recoveryAttempts.delete(sessionId)
  }

  /**
   * Send IPC notification to renderer process about recovery events.
   * Uses BrowserWindow.getAllWindows() to reach all renderer windows.
   */
  private _notifyRenderer(event: RecoveryEvent): void {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (event.type === 'SESSION_RECOVERED') {
          win.webContents.send('session:recovered', event.sessionId, event.newSessionId ?? '')
        } else {
          win.webContents.send('session:recoveryFailed', event.sessionId, event.reason ?? '')
        }
      }
    } catch (err) {
      logger.warn('Failed to notify renderer about recovery event:', err)
    }
  }
}

let _instance: SessionRecoveryManager | null = null

/** 测试用：重置单例 */
export function setForTesting(instance: SessionRecoveryManager | null): void {
  _instance = instance
}

export function getSessionRecoveryManager(): SessionRecoveryManager {
  if (!_instance) _instance = new SessionRecoveryManager()
  return _instance
}
