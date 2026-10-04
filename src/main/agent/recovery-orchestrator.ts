/**
 * RecoveryOrchestrator — 会话恢复协调器
 *
 * 封装会话从异常退出到恢复的所有决策与副作用：
 * 1. 判断 exit 是否可恢复（126/127/success/idle 不恢复）
 * 2. 调用 SessionRecoveryManager.attemptRecovery 决定 resume / replacement / 放弃
 * 3. 处理 MCP adapter 的 context injection 回退路径（创建替换 session + 重发上一指令）
 * 4. 维护两套 timer：
 *    - fallbackRecoveryTimers: 监控首选适配器是否健康恢复（fallback 后周期性探测）
 *    - recoveryCheckIntervals: 健康度为 unhealthy 的适配器周期性探测（用于 health-driven 恢复）
 * 5. 把恢复结果通知路由层与 SessionState 映射
 *
 * 此模块替代 AgentManager 中以下方法的实现：
 * - _handleSessionEnded
 * - _resumeLastCommand
 * - _extractRecentMessages
 * - _startFallbackRecoveryCheck
 * - startRecoveryCheck
 *
 * AgentManager 通过 sessionEnded 事件钩子调用 handleSessionExit()，
 * 由 startSession 内 fallback 成功分支调用 startFallbackRecoveryCheck()，
 * 由 FallbackRouter 在命中 unhealthy 时回调 startRecoveryCheck()。
 */

import type { AgentCommand, AgentCommandType, AgentSessionConfig, AgentOutput, Sandbox } from '@shared/types'
import { getSessionRecoveryManager, type SessionRecoveryManager } from './session-recovery'
import type { AdapterHealthMonitor } from './adapter-health-monitor'
import type { AdapterRegistry } from './adapter-registry'
import type { SessionRouter } from './session-router'
import { createLogger } from '../shared/logger'

const logger = createLogger('RecoveryOrchestrator')

/** handleSessionExit 的返回值语义 */
export type RecoveryOutcome = 'native' | 'replacement' | 'none'

/** 启动新会话的回调（由 AgentManager 注入，避免循环依赖） */
export type StartSessionFn = (adapterName: string, config: AgentSessionConfig) => Promise<{
  sessionId: string
  fallback?: boolean
  adapterUsed: string
  fallbackHistory: unknown[]
}>

/** 发送命令的回调（由 AgentManager 注入） */
export type SendCommandFn = (sessionId: string, command: AgentCommand) => Promise<void>

interface StartFallbackRecoveryOptions {
  interval?: number
  /** Timeout before the fallback recovery loop gives up. Default 5 minutes. */
  timeoutMs?: number
}

/** 与 AgentManager.SessionState 兼容的最小子集 —— 本模块只读 config/originSessionId/lastCommand 等 */
export interface RecoverySessionState {
  config: AgentSessionConfig
  broadcastName: string
  adapterName: string
  startTime: number
  sandbox?: Sandbox
  lastCommandType?: AgentCommandType
  promptTokenEstimate?: number
  contextCount?: number
  threadId?: string
  parentSessionId?: string
  swarmTaskId?: string
  tokensUsed?: number
  terminationReason?: 'success' | 'crash' | 'error' | 'timeout' | 'user' | 'idle'
  lastCommand?: AgentCommand
  originSessionId?: string
}

export class RecoveryOrchestrator {
  /** 周期性探测首选适配器（fallback 后）：定时器对每个 preferred adapter 名一个 */
  private fallbackRecoveryTimers = new Map<
    string,
    { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }
  >()

  /** 健康度 unhealthy 的适配器周期性探测：每个 adapter 名一个 */
  private recoveryCheckIntervals = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly healthMonitor: AdapterHealthMonitor,
    private readonly sessionRouter: SessionRouter,
    private readonly sessionStates: Map<string, RecoverySessionState>,
    private readonly sessionBroadcastNames: Map<string, string>,
    /** AgentManager 注入的 startSession，用于 MCP 恢复路径 */
    private readonly startSessionFn: StartSessionFn,
    /** AgentManager 注入的 sendCommand，用于在恢复后重发最后一条指令 */
    private readonly sendCommandFn: SendCommandFn,
    /** 全局 SessionRecoveryManager 单例，可注入便于测试 */
    private readonly sessionRecovery: SessionRecoveryManager = getSessionRecoveryManager(),
  ) {}

  /** 暴露 recoveryCheckIntervals（兼容原 AgentManager API —— 测试通过 (manager as any).recoveryCheckIntervals 访问） */
  get recoveryCheckMap(): Map<string, ReturnType<typeof setInterval>> {
    return this.recoveryCheckIntervals
  }

  /** 暴露 fallbackRecoveryTimers（AgentManager 内部使用） */
  get fallbackRecoveryTimerMap(): Map<
    string,
    { interval: ReturnType<typeof setInterval>; timeout: ReturnType<typeof setTimeout> }
  > {
    return this.fallbackRecoveryTimers
  }

  /** 暴露 sessionRecovery 供测试访问（manager['sessionRecovery'] 的兼容层） */
  get sessionRecoveryManager(): SessionRecoveryManager {
    return this.sessionRecovery
  }

  /**
   * 处理 session 异常退出事件，决定是否走恢复路径
   *
   * 返回值：
   * - 'native': 原 sessionId 已被原生 resume（Claude Code --resume），保持活动
   * - 'replacement': 已创建新 session 替换当前（用户命令将重发）
   * - 'none': 无需恢复（已清理或恢复失败）
   */
  async handleSessionExit(
    sessionId: string,
    exitCode: number | null,
    reason: string,
    state: RecoverySessionState,
    outputs: AgentOutput[],
  ): Promise<RecoveryOutcome> {
    if ((exitCode === 137 || exitCode === 143) && reason !== 'timeout') {
      logger.info(`Session ${sessionId} terminated normally (exit ${exitCode})`)
      return 'none'
    }

    const isRecoverable =
      (reason === 'crash' || reason === 'error' || reason === 'timeout') &&
      exitCode !== 126 &&
      exitCode !== 127

    if (!isRecoverable) {
      if (exitCode === 126 || exitCode === 127) {
        this.healthMonitor.recordCall(
          state.adapterName,
          false,
          0,
          `Exit code ${exitCode}: adapter not available`,
        )
        logger.warn(`Adapter ${state.adapterName} marked unavailable (exit ${exitCode})`)
      } else {
        logger.warn(`Session ${sessionId} exited with code ${exitCode}, reason: ${reason}`)
      }
      return 'none'
    }

    const lastMessages = this.extractRecentMessages(outputs)
    const threadId = await this.lookupThreadId(state.config.nodeId)
    const originSessionId = state.originSessionId ?? sessionId

    const newSessionId = await this.sessionRecovery.attemptRecovery({
      sessionId,
      adapterName: state.adapterName,
      projectId: state.config.workingDirectory,
      lastOutputs: outputs,
      lastMessages,
      threadId,
      originSessionId,
    })

    if (newSessionId) {
      logger.info(`Session ${sessionId} recovered as ${newSessionId}`)

      if (newSessionId === sessionId) {
        // Native resume: keep the same sessionId active in the manager's maps.
        this.sessionStates.set(sessionId, state)
        this.sessionBroadcastNames.set(sessionId, state.broadcastName)
        this.sessionRouter.bind(sessionId, state.adapterName)
        return 'native'
      }

      const newState = this.sessionStates.get(newSessionId)
      if (newState) {
        newState.originSessionId = originSessionId
      }
      if (state.lastCommand) {
        await this.resumeLastCommand(newSessionId, state.lastCommand)
      }
      return 'replacement'
    }

    // MCP adapter recovery left a pending context injection: create a new session.
    const pendingContext = this.sessionRecovery.consumePendingContext(sessionId)
    if (pendingContext) {
      logger.info(`Session ${sessionId}: creating new MCP session with context injection`)
      try {
        const config = { ...state.config, contextSummary: pendingContext }
        const result = await this.startSessionFn(state.adapterName, config)
        logger.info(
          `Session ${sessionId} replaced by new session ${result.sessionId} with context injection`,
        )
        const replacementState = this.sessionStates.get(result.sessionId)
        if (replacementState) {
          replacementState.originSessionId = originSessionId
        }
        if (state.lastCommand) {
          await this.resumeLastCommand(result.sessionId, state.lastCommand)
        } else {
          logger.info(
            `Replacement session ${result.sessionId} started idle; no previous command to resume`,
          )
        }
        return 'replacement'
      } catch (err) {
        logger.warn(`Failed to create new MCP session for recovery:`, err)
      }
    }

    return 'none'
  }

  /**
   * 在 fallback 成功后启动周期性探测：当首选适配器恢复健康时记录一次成功调用，
   * 让 AdapterHealthMonitor 在下次 session 启动时回滚 fallback 选择。
   */
  startFallbackRecoveryCheck(preferredAdapter: string, options: StartFallbackRecoveryOptions = {}): void {
    if (this.fallbackRecoveryTimers.has(preferredAdapter)) return
    const intervalMs = options.interval ?? 60_000
    const timeoutMs = options.timeoutMs ?? 5 * 60_000

    const interval = setInterval(async () => {
      const adapter = this.registry.get(preferredAdapter)
      if (!adapter) {
        clearInterval(interval)
        const t = this.fallbackRecoveryTimers.get(preferredAdapter)
        if (t) clearTimeout(t.timeout)
        this.fallbackRecoveryTimers.delete(preferredAdapter)
        return
      }
      const installed = await adapter.checkInstalled()
      const health = this.healthMonitor.getHealth(preferredAdapter)
      if (installed && health && health.status === 'healthy') {
        logger.info(`Preferred adapter ${preferredAdapter} is healthy again`)
        const timers = this.fallbackRecoveryTimers.get(preferredAdapter)
        if (timers) {
          clearInterval(timers.interval)
          clearTimeout(timers.timeout)
        }
        this.fallbackRecoveryTimers.delete(preferredAdapter)
      }
    }, intervalMs)

    const timeout = setTimeout(() => {
      clearInterval(interval)
      this.fallbackRecoveryTimers.delete(preferredAdapter)
    }, timeoutMs)
    timeout.unref()

    this.fallbackRecoveryTimers.set(preferredAdapter, { interval, timeout })
  }

  /**
   * 健康度为 unhealthy 的适配器周期性探测：检测到可用后向健康监控记录一次成功，
   * 让 AdapterHealthMonitor 把它从 blacklist 中移除。
   *
   * 与 startFallbackRecoveryCheck 的区别：本方法由 FallbackRouter 在
   * 命中 unhealthy 时直接调用，且每次只记录「适配器安装可用」的成功。
   */
  startRecoveryCheck(adapterName: string): void {
    if (this.recoveryCheckIntervals.has(adapterName)) return
    const interval = setInterval(async () => {
      const adapter = this.registry.get(adapterName)
      if (!adapter) {
        const active = this.recoveryCheckIntervals.get(adapterName)
        if (active) {
          clearInterval(active)
          this.recoveryCheckIntervals.delete(adapterName)
        }
        return
      }
      const installed = await adapter.checkInstalled()
      if (installed) {
        this.healthMonitor.recordCall(adapterName, true, 0, 'recovery-check')
        const active = this.recoveryCheckIntervals.get(adapterName)
        if (active) {
          clearInterval(active)
          this.recoveryCheckIntervals.delete(adapterName)
        }
      }
    }, 60_000)
    this.recoveryCheckIntervals.set(adapterName, interval)
  }

  /**
   * 清理所有 timer（AgentManager.destroy 时调用）
   */
  destroy(): void {
    for (const timers of this.fallbackRecoveryTimers.values()) {
      clearInterval(timers.interval)
      clearTimeout(timers.timeout)
    }
    this.fallbackRecoveryTimers.clear()
    for (const interval of this.recoveryCheckIntervals.values()) {
      clearInterval(interval)
    }
    this.recoveryCheckIntervals.clear()
  }

  // ---- 私有辅助 ----

  private async resumeLastCommand(sessionId: string, command: AgentCommand): Promise<void> {
    if (!this.sessionStates.has(sessionId)) {
      logger.warn(`Cannot resume command: recovered session ${sessionId} is not ready`)
      return
    }
    const adapter = this.sessionRouter.resolve(sessionId)
    if (!adapter) {
      logger.warn(
        `Cannot resume command: no adapter bound to recovered session ${sessionId}`,
      )
      return
    }
    try {
      await this.sendCommandFn(sessionId, command)
      logger.info(`Resumed last command on recovered session ${sessionId}`)
    } catch (err) {
      logger.warn(`Failed to resume last command on recovered session ${sessionId}:`, err)
    }
  }

  /**
   * 从 session 输出缓冲区中抽取最近的消息用于恢复时上下文注入。
   * 把 stdout 块拼成一个 assistant 消息（最多 2000 字符）。
   */
  private extractRecentMessages(outputs: AgentOutput[]): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = []
    const stdoutChunks: string[] = []
    for (const output of outputs) {
      if (output.type === 'stdout') {
        stdoutChunks.push(output.data)
      }
    }
    if (stdoutChunks.length > 0) {
      const combined = stdoutChunks.join('')
      messages.push({
        role: 'assistant',
        content: combined.slice(-2000),
      })
    }
    return messages
  }

  /** 从 chat_threads 查找当前 nodeId 对应的最近线程（仅用于通知，可失败） */
  private async lookupThreadId(nodeId: string | undefined): Promise<string | undefined> {
    if (!nodeId) return undefined
    try {
      const { getClient } = await import('../database')
      const db = getClient()
      const row = db
        .prepare(
          'SELECT id FROM chat_threads WHERE node_id = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(nodeId) as { id: string } | undefined
      return row?.id
    } catch {
      return undefined
    }
  }
}