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

type CodexConstructor = typeof import('@openai/codex-sdk').Codex

export class CodexAdapter extends BaseAdapter {
  readonly name = 'codex'
  readonly version = '2.0.0'

  private CodexClass: CodexConstructor | null = null
  private sdkLoadAttempted = false
  private threads = new Map<string, ReturnType<InstanceType<CodexConstructor>['startThread']>>()
  private threadIds = new Map<string, string>()

  private async loadSdk(): Promise<CodexConstructor | null> {
    if (this.sdkLoadAttempted) return this.CodexClass
    this.sdkLoadAttempted = true

    try {
      const mod = await import('@openai/codex-sdk')
      this.CodexClass = mod.Codex
      return this.CodexClass
    } catch {
      console.warn('[CodexAdapter] @openai/codex-sdk not installed')
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
      config,
      startTime: Date.now(),
    }
    this.registerSession(session)
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const CodexClass = await this.loadSdk()
    if (!CodexClass) {
      throw new AdapterError('Codex SDK not installed. Run: npm install @openai/codex-sdk', this.name)
    }

    const scopePrompt = this.buildScopePrompt(session.config, session.resolvedContexts)
    const commandPrompt = this.buildCommandPrompt(command)
    const fullPrompt = `${scopePrompt}\n\n${commandPrompt}`

    try {
      const codex = new CodexClass({
        env: this.buildSafeEnv() as Record<string, string>,
      })

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

      // 保存 thread ID 用于后续续接
      const threadId = thread.id
      if (threadId) {
        this.threadIds.set(session.id, threadId)
        session.config.resumeSessionId = threadId
      }

      // 输出 agent 消息
      for (const item of result.items) {
        if (item.type === 'agent_message' && item.text) {
          this.emitOutput({
            type: 'stdout',
            data: item.text,
            timestamp: Date.now(),
          })
        }
        if (item.type === 'file_change') {
          for (const change of item.changes) {
            this.emitOutput({
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
        this.emitOutput({
          type: 'stdout',
          data: result.finalResponse,
          timestamp: Date.now(),
        })
      }

      this.emitOutput({
        type: 'complete',
        data: 'Codex session completed',
        timestamp: Date.now(),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutput({
        type: 'error',
        data: `Codex SDK error: ${msg}`,
        timestamp: Date.now(),
        errorCode: 'AGENT_CRASH',
      })
    }
  }

  protected doCloseQuery(sessionId: string): void {
    this.threads.delete(sessionId)
    this.threadIds.delete(sessionId)
  }
}
