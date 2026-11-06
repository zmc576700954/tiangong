/**
 * Codex 适配器（SDK 模式）
 *
 * 使用 @openai/codex-sdk 替代 spawn('codex') 子进程调用。
 * SDK 提供线程模型（startThread/resumeThread）和结构化结果。
 *
 * P1-B：双路径
 * - 旧 `AgentOutput` 路径：保持原有阻塞 `thread.run()` 语义（含 `finalResponse` 广播）；
 * - 新 Runtime/Kernel 路径（`setRawStreamMode(true)`）：走 `thread.runStreamed()`，
 *   以 `turn.completed` 判完成，raw 事件供 Driver 归一化。
 */

import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import { isTrustedNativeSessionId } from '@shared/native-session-id'
import { humanizeAgentErrorText } from '@shared/agent-error-text'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { AdapterError } from '../errors'
import type { Codex } from '@openai/codex-sdk'
import type { ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import { createLogger } from '../shared/logger'
import {
  ensureCodexSupervisorScript,
  getProcRegistryDir,
  getRegistrySecret,
  PROC_REGISTRY_DIR_ENV,
  REAL_CODEX_ENV,
  REGISTRY_SECRET_ENV,
  resolveRealCodexPath,
  SUPERVISOR_NONCE_ENV,
} from '../shared/process-supervisor'

type CodexConstructor = typeof Codex

/** runStreamed 事件的最小结构（SDK 的联合类型在运行时才有完整形状）。 */
interface CodexStreamedEvent {
  type: string
  item?: {
    id?: string
    type: string
    text?: string
    changes?: Array<{ path: string; kind: 'add' | 'modify' | 'delete' }>
  }
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number }
  error?: { message?: string }
}

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex'
  readonly version = '2.0.0'

  protected override logger = createLogger('CodexAdapter')

  /**
   * SDK 多轮适配器：BaseAdapter 自动托管空闲回收定时器。
   * registerSession / sendCommand 处基类自动 arm / re-arm，无需手动。
   */
  protected get autoManageIdleReaper(): boolean {
    return true
  }

  private CodexClass: CodexConstructor | null = null
  private sdkLoadAttempted = false
  private threads = new Map<string, ReturnType<InstanceType<CodexConstructor>['startThread']>>()
  private threadIds = new Map<string, string>()
  /** Session-level Codex instances: reuse across doSendCommand calls within the same session */
  private codexInstances = new Map<string, InstanceType<CodexConstructor>>()
  /** D-C：可取消的流式轮次（terminateSession 会 abort） */
  private abortControllers = new Map<string, AbortController>()

  private async loadSdk(): Promise<CodexConstructor | null> {
    if (this.sdkLoadAttempted) return this.CodexClass
    this.sdkLoadAttempted = true

    try {
      const mod = await import('@openai/codex-sdk')
      this.CodexClass = mod.Codex
      return this.CodexClass
    } catch {
      this.logger.warn('@openai/codex-sdk not installed')
      return null
    }
  }

  async checkInstalled(): Promise<boolean> {
    const cls = await this.loadSdk()
    return cls !== null
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('codex')
    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session)
    // Idle reaper 由 BaseAdapter.registerSession 自动 arm（autoManageIdleReaper=true）。
    return session
  }

  /** Codex 支持 `resumeThread(threadId)`，重启后可用原生续接。 */
  supportsNativeResume(): boolean {
    return true
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const sessionId = session.id
    const CodexClass = await this.loadSdk()
    if (!CodexClass) {
      throw new AdapterError('Codex SDK not installed. Run: npm install @openai/codex-sdk', this.name)
    }

    const fullPrompt = this.buildFullPrompt(session, command)

    try {
      // D5：受控 spawn 模式每轮重建 Codex 实例/线程，保证 marker 与 shim 路径都是本轮的；
      // 旧 AgentOutput 路径仍沿用会话级缓存，行为不变。
      const supervised = this.isProcessSupervised(sessionId) && process.platform !== 'win32'
      let codex = supervised ? null : this.codexInstances.get(session.id)
      if (!codex) {
        const safeEnv = this.buildSessionEnv(session.id)
        const env = Object.fromEntries(
          Object.entries(safeEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        if (supervised) {
          const realCodex = resolveRealCodexPath()
          if (!realCodex) {
            throw new AdapterError(
              'Cannot resolve @openai/codex/bin/codex.js for supervised spawn',
              this.name,
            )
          }
          env[PROC_REGISTRY_DIR_ENV] = getProcRegistryDir()
          env[REAL_CODEX_ENV] = realCodex
          // C12：每次 spawn 的 nonce + 安装级签名密钥（仅经 env 注入，ps 不可见）
          env[SUPERVISOR_NONCE_ENV] = crypto.randomBytes(16).toString('hex')
          env[REGISTRY_SECRET_ENV] = getRegistrySecret()
          codex = new CodexClass({ env, codexPathOverride: ensureCodexSupervisorScript() })
        } else {
          codex = new CodexClass({ env })
          this.codexInstances.set(session.id, codex)
        }
      }

      const isResume = session.config.resumeSessionId != null
      let thread = supervised ? null : this.threads.get(session.id)

      if (!thread) {
        if (isResume && isTrustedNativeSessionId(session.config.resumeSessionId)) {
          thread = codex.resumeThread(session.config.resumeSessionId, {
            workingDirectory: session.config.workingDirectory,
            sandboxMode: 'workspace-write',
          })
        } else {
          thread = codex.startThread({
            workingDirectory: session.config.workingDirectory,
            sandboxMode: 'workspace-write',
          })
        }
        if (!supervised) this.threads.set(session.id, thread)
      }

      // 双路径：旧 AgentOutput 路径保持阻塞 run()；仅 Runtime/Kernel 路径走 runStreamed()。
      if (!this.isRawStreamMode(sessionId)) {
        await this.runBlocking(session, thread, fullPrompt)
        return
      }
      await this.runStreaming(session, thread, fullPrompt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: humanizeAgentErrorText(`Codex SDK error: ${msg}`),
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
      // 错误仍需通知 AgentManager 以触发会话恢复/清理流程
      this.emit('sessionEnded', session.id, 'error', null)
    }
  }

  /** 旧 `AgentOutput` 路径：阻塞 `thread.run()`，行为与 M0 改造前一致。 */
  private async runBlocking(
    session: AgentSession,
    thread: ReturnType<InstanceType<CodexConstructor>['startThread']>,
    fullPrompt: string,
  ): Promise<void> {
    const sessionId = session.id
    const result = await thread.run(fullPrompt)

    // 上报 token 使用量（M1：全量真实用量分列，供 UsageLedger 计价落库）
    if (result.usage) {
      const inputTokens = result.usage.input_tokens ?? 0
      if (inputTokens > 0) {
        this.reportUsage(session.id, inputTokens, 128_000, {
          outputTokens: result.usage.output_tokens ?? 0,
          cachedInputTokens: result.usage.cached_input_tokens ?? 0,
          source: 'provider',
        })
      }
    }

    // 保存 thread ID 用于后续续接
    const threadId = thread.id
    if (threadId) {
      this.threadIds.set(session.id, threadId)
      session.config.resumeSessionId = threadId
    }

    // 输出 agent 消息
    for (const item of result.items) {
      if (item.type === 'agent_message' && item.text) {
        this.emitOutputForSession(sessionId, {
          type: 'stdout',
          data: item.text,
          timestamp: Date.now(),
        })
      }
      if (item.type === 'file_change') {
        for (const change of item.changes) {
          this.emitOutputForSession(sessionId, {
            type: 'file_change',
            data: `${change.kind}: ${change.path}`,
            timestamp: Date.now(),
            filePath: change.path,
            changeType: change.kind === 'add' ? 'add' : change.kind === 'delete' ? 'delete' : 'modify',
          })
        }
      }
    }

    if (result.finalResponse) {
      this.emitOutputForSession(sessionId, {
        type: 'stdout',
        data: result.finalResponse,
        timestamp: Date.now(),
      })
    }

    this.emitOutputForSession(sessionId, {
      type: 'complete',
      data: 'Codex session completed',
      timestamp: Date.now(),
    })
    // codex 缓存 thread/instance 以支持多轮续接，单命令成功不应销毁会话（参考 claude-code）。
    // 资源清理由显式 terminateSession 或空闲回收定时器（BaseAdapter 自动 re-arm）负责，
    // 后者在无活动窗口后通过 sessionEnded('idle') 让 AgentManager 执行完整清理，包括记忆管线。
  }

  /** 新 Runtime/Kernel 路径：`runStreamed()`，以后端 `turn.completed` 判完成。 */
  private async runStreaming(
    session: AgentSession,
    thread: ReturnType<InstanceType<CodexConstructor>['startThread']>,
    fullPrompt: string,
  ): Promise<void> {
    const sessionId = session.id
    const controller = new AbortController()
    this.abortControllers.set(session.id, controller)
    const stream = await thread.runStreamed(fullPrompt, { signal: controller.signal })
    let completed = false

    try {
      for await (const rawEvent of stream.events) {
        const event = rawEvent as unknown as CodexStreamedEvent
        // D3：原始事件只读旁路（Driver 归一化用；旧路径不订阅）
        this.emitRawEvent(sessionId, 'codex', event)

        if (event.type === 'item.completed' && event.item) {
          const item = event.item
          if (item.type === 'agent_message' && item.text) {
            this.emitOutputForSession(sessionId, {
              type: 'stdout',
              data: item.text,
              timestamp: Date.now(),
            })
          }
          if (item.type === 'file_change') {
            for (const change of item.changes ?? []) {
              this.emitOutputForSession(sessionId, {
                type: 'file_change',
                data: `${change.kind}: ${change.path}`,
                timestamp: Date.now(),
                filePath: change.path,
                changeType: change.kind === 'add' ? 'add' : change.kind === 'delete' ? 'delete' : 'modify',
              })
            }
          }
          continue
        }

        if (event.type === 'turn.completed') {
          // C1：turn.completed 即完成判定；不等待迭代器/进程退出（后者约 10s）
          // M1：Codex 的真实 usage 只在 turn.completed 出现，全量上报
          if (event.usage) {
            const inputTokens = event.usage.input_tokens ?? 0
            if (inputTokens > 0) {
              this.reportUsage(session.id, inputTokens, 128_000, {
                outputTokens: event.usage.output_tokens ?? 0,
                cachedInputTokens: event.usage.cached_input_tokens ?? 0,
                source: 'provider',
              })
            }
          }
          completed = true
          this.emitOutputForSession(sessionId, {
            type: 'complete',
            data: 'Codex session completed',
            timestamp: Date.now(),
          })
          break
        }

        if (event.type === 'turn.failed') {
          const message = event.error?.message ?? 'Codex turn failed'
          this.emitOutputForSession(sessionId, {
            type: 'error',
            data: humanizeAgentErrorText(`Codex SDK error: ${message}`),
            timestamp: Date.now(),
            errorCode: 'AGENT_CRASH',
          })
          this.emit('sessionEnded', session.id, 'error', null)
          return
        }
        // C5：未知事件类型直接忽略
      }
    } finally {
      if (this.abortControllers.get(session.id) === controller) {
        this.abortControllers.delete(session.id)
      }
    }

    if (!completed) {
      // C1 的反面：没有 turn.completed 不能宣称成功
      const message = controller.signal.aborted ? 'Codex turn aborted' : 'Codex stream ended without turn.completed'
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: humanizeAgentErrorText(`Codex SDK error: ${message}`),
        timestamp: Date.now(),
        errorCode: controller.signal.aborted ? 'AGENT_ABORTED' : 'AGENT_CRASH',
      })
      if (!controller.signal.aborted) this.emit('sessionEnded', session.id, 'error', null)
      return
    }

    // 保存 thread ID 用于后续续接
    const threadId = thread.id
    if (threadId) {
      this.threadIds.set(session.id, threadId)
      session.config.resumeSessionId = threadId
    }
    // codex 缓存 thread/instance 以支持多轮续接，单命令成功不应销毁会话（参考 claude-code）。
  }

  protected doCloseQuery(sessionId: string): void {
    this.abortControllers.get(sessionId)?.abort()
    this.abortControllers.delete(sessionId)
    this.threads.delete(sessionId)
    this.threadIds.delete(sessionId)
    this.codexInstances.delete(sessionId)
  }

  protected override async doTerminate(_session: AgentSession, _proc?: ChildProcess): Promise<void> {
    this.doCloseQuery(_session.id)
    await super.doTerminate(_session, _proc)
  }
}
