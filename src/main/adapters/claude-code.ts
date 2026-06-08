/**
 * Claude Code 适配器（Agent SDK 模式）
 *
 * 使用 @anthropic-ai/claude-agent-sdk 替代 spawn('claude') 子进程调用。
 * SDK 提供类型化消息流、内置会话管理和生命周期 Hooks。
 *
 * 安全设计保持不变：
 * - prompt 内容通过 SDK 参数传入，不经过命令行
 * - buildSafeEnv() 控制子进程环境变量
 * - 动态导入 SDK，未安装时优雅降级
 */

import { BaseAdapter } from './base'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { AdapterError } from '../errors'
import { createLogger } from '../shared/logger'

type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk').query

function isAssistantMessage(msg: unknown): msg is {
  content?: Array<{ type: string; text?: string }>
} {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  if (!Array.isArray(m.content)) return false
  return m.content.every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Record<string, unknown>).type === 'string',
  )
}

function isResultMessage(msg: unknown): msg is {
  is_error: boolean
  result?: string
  errors?: string[]
} {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as Record<string, unknown>
  return typeof m.is_error === 'boolean'
}

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'claude-code'
  readonly version = '2.0.0'

  private logger = createLogger('ClaudeCodeAdapter')

  private sdkQuery: QueryFn | null = null
  private sdkLoadAttempted = false
  private activeQueries = new Map<string, { abort: () => void }>()

  private async loadSdk(): Promise<QueryFn | null> {
    if (this.sdkLoadAttempted) return this.sdkQuery
    this.sdkLoadAttempted = true

    try {
      const mod = await import('@anthropic-ai/claude-agent-sdk')
      this.sdkQuery = mod.query
      return this.sdkQuery
    } catch {
      this.logger.warn('@anthropic-ai/claude-agent-sdk not installed')
      return null
    }
  }

  async checkInstalled(): Promise<boolean> {
    const query = await this.loadSdk()
    return query !== null
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('claude')
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
    const query = await this.loadSdk()
    if (!query) {
      throw new AdapterError(
        'Claude Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
        this.name,
      )
    }

    const scopePrompt = this.buildScopePrompt(session.config, session.resolvedContexts)
    const commandPrompt = this.buildCommandPrompt(command)

    const abortController = new AbortController()
    this.activeQueries.set(session.id, { abort: () => abortController.abort() })

    try {
      const queryIter = query({
        prompt: commandPrompt,
        options: {
          systemPrompt: scopePrompt,
          cwd: session.config.workingDirectory,
          model: 'sonnet',
          env: this.buildSafeEnv(),
          permissionMode: 'acceptEdits',
          ...(session.config.resumeSessionId ? { resume: session.config.resumeSessionId } : {}),
          hooks: {
            PostToolUse: [
              {
                matcher: 'Edit|Write',
                hooks: [
                  async (input: unknown) => {
                    const hookInput =
                      typeof input === 'object' && input !== null
                        ? (input as Record<string, unknown>)
                        : {}
                    const toolInput =
                      typeof hookInput.tool_input === 'object' && hookInput.tool_input !== null
                        ? (hookInput.tool_input as Record<string, unknown>)
                        : {}
                    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined
                    const toolName = typeof hookInput.tool_name === 'string' ? hookInput.tool_name : undefined
                    if (filePath) {
                      const isCreate = toolName === 'Write'
                      this.emitOutput({
                        type: 'file_change',
                        data: `${isCreate ? 'create' : 'modify'}: ${filePath}`,
                        timestamp: Date.now(),
                        filePath,
                        changeType: isCreate ? 'add' : 'modify',
                      })
                    }
                    return {}
                  },
                ],
              },
            ],
          },
        },
      })

      for await (const message of queryIter) {
        if (abortController.signal.aborted) break

        if (message.type === 'system' && message.subtype === 'init') {
          // SDK 管理的 session_id，用于多轮续接
          session.config.resumeSessionId = message.session_id
          continue
        }

        if (message.type === 'assistant') {
          if (isAssistantMessage(message.message)) {
            for (const block of message.message.content ?? []) {
              if (block.type === 'text' && block.text) {
                this.emitOutput({
                  type: 'stdout',
                  data: block.text,
                  timestamp: Date.now(),
                })
              }
            }
          }
          continue
        }

        if (message.type === 'result') {
          if (isResultMessage(message)) {
            if (message.is_error) {
              const errorText =
                (Array.isArray(message.errors) ? message.errors.join('\n') : undefined) ??
                (typeof message.result === 'string' ? message.result : undefined) ??
                'Agent execution failed'
              this.emitOutput({
                type: 'error',
                data: errorText,
                timestamp: Date.now(),
                errorCode: 'AGENT_CRASH',
              })
            } else {
              this.emitOutput({
                type: 'complete',
                data: typeof message.result === 'string' ? message.result : 'Completed',
                timestamp: Date.now(),
              })
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (err instanceof Error && err.name === 'AbortError') {
        this.emitOutput({
          type: 'complete',
          data: 'Session cancelled by user',
          timestamp: Date.now(),
        })
      } else {
        this.emitOutput({
          type: 'error',
          data: `SDK error: ${msg}`,
          timestamp: Date.now(),
          errorCode: 'AGENT_CRASH',
        })
      }
    } finally {
      this.activeQueries.delete(session.id)
    }
  }

  protected doCloseQuery(sessionId: string): void {
    const active = this.activeQueries.get(sessionId)
    if (active) {
      active.abort()
      this.activeQueries.delete(sessionId)
    }
  }
}
