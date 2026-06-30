/**
 * Codex 适配器（SDK 模式）
 *
 * 使用 @openai/codex-sdk 替代 spawn('codex') 子进程调用。
 * SDK 提供线程模型（startThread/resumeThread）和结构化结果。
 */

import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { AdapterError } from '../errors'
import type { Codex } from '@openai/codex-sdk'
import type { ChildProcess } from 'node:child_process'
import { createLogger } from '../shared/logger'

type CodexConstructor = typeof Codex

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex'
  readonly version = '2.0.0'

  protected override logger = createLogger('CodexAdapter')

  private CodexClass: CodexConstructor | null = null
  private sdkLoadAttempted = false
  private threads = new Map<string, ReturnType<InstanceType<CodexConstructor>['startThread']>>()
  private threadIds = new Map<string, string>()
  /** Session-level Codex instances: reuse across doSendCommand calls within the same session */
  private codexInstances = new Map<string, InstanceType<CodexConstructor>>()

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
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const sessionId = session.id
    const CodexClass = await this.loadSdk()
    if (!CodexClass) {
      throw new AdapterError('Codex SDK not installed. Run: npm install @openai/codex-sdk', this.name)
    }

    const scopePrompt = this.buildScopePromptForSession(session)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    try {
      let codex = this.codexInstances.get(session.id)
      if (!codex) {
        const safeEnv = this.buildSafeEnv()
        const env = Object.fromEntries(
          Object.entries(safeEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        codex = new CodexClass({ env })
        this.codexInstances.set(session.id, codex)
      }

      const isResume = session.config.resumeSessionId != null
      let thread = this.threads.get(session.id)

      if (!thread) {
        if (isResume && session.config.resumeSessionId) {
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
        this.threads.set(session.id, thread)
      }

      const result = await thread.run(fullPrompt)

      // 上报 token 使用量供 ContextWaterline 监控（Phase 3 Task 34）
      if (result.usage) {
        const inputTokens =
          (result.usage.input_tokens ?? 0) +
          (result.usage.cached_input_tokens ?? 0)
        if (inputTokens > 0) {
          this.reportUsage(session.id, inputTokens, 128_000)
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
      // 不在此处 emit sessionEnded('success')：codex 缓存 thread/instance 以支持多轮续接，
      // 单命令成功不应销毁会话（参考 claude-code）。资源清理由显式 terminateSession 负责。
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: `Codex SDK error: ${msg}`,
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
      // 错误仍需通知 AgentManager 以触发会话恢复/清理流程
      this.emit('sessionEnded', session.id, 'error', null)
    }
  }

  protected doCloseQuery(sessionId: string): void {
    this.threads.delete(sessionId)
    this.threadIds.delete(sessionId)
    this.codexInstances.delete(sessionId)
  }

  protected override async doTerminate(_session: AgentSession, _proc?: ChildProcess): Promise<void> {
    this.threads.delete(_session.id)
    this.threadIds.delete(_session.id)
    this.codexInstances.delete(_session.id)
    await super.doTerminate(_session, _proc)
  }
}
