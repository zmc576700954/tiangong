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
import type {
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  CompactResult,
  CompactTrigger,
} from '@shared/types'
import { AdapterError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import { estimateTokens } from '../shared/token-utils'

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


export class ClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'claude-code'
  readonly version = '2.0.0'

  protected logger = createLogger('ClaudeCodeAdapter')

  private sdkQuery: QueryFn | null = null
  private sdkLoadAttempted = false
  private activeQueries = new Map<string, { abort: () => void }>()
  /** Sessions flagged for auto-compaction on the next query() call */
  private autoCompactEnabledFor = new Set<string>()

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

    const scopePrompt = this.buildScopePromptForSession(session)
    const commandPrompt = this.buildCommandPrompt(command)

    const abortController = new AbortController()
    this.activeQueries.set(session.id, { abort: () => abortController.abort() })

    try {
      const { readSettings } = await import('../settings')
      const settings = await readSettings()
      const queryIter = query({
        prompt: commandPrompt,
        options: {
          systemPrompt: scopePrompt,
          cwd: session.config.workingDirectory,
          model: settings.defaultModel || 'sonnet',
          env: this.buildSafeEnv(),
          permissionMode: 'acceptEdits',
          ...(session.config.resumeSessionId ? { resume: session.config.resumeSessionId } : {}),
          ...(this.autoCompactEnabledFor.has(session.id) ? { autoCompactEnabled: true } : {}),
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
          // Report authoritative token usage to the AgentManager budget tracker
          if (message.usage) {
            const inputTokens = (message.usage as { input_tokens?: number }).input_tokens ?? 0
            if (inputTokens > 0) {
              this.reportUsage(session.id, inputTokens)
            }
          }
          if (message.subtype === 'success') {
            this.emitOutput({
              type: 'complete',
              data: message.result || 'Completed',
              timestamp: Date.now(),
            })
          } else {
            const errorText =
              (message.errors.length > 0 ? message.errors.join('\n') : undefined) ??
              'Agent execution failed'
            this.emitOutput({
              type: 'error',
              data: errorText,
              timestamp: Date.now(),
              errorCode: 'AGENT_CRASH',
            })
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
    // Clear the auto-compact flag when the session ends; a new session must opt in again
    this.autoCompactEnabledFor.delete(sessionId)
  }

  /**
   * Native compact for Claude Code:
   * The Agent SDK does not expose a synchronous /compact API, so "native" compaction
   * here means flagging the session so the next query() call passes
   * `autoCompactEnabled: true`, letting the SDK perform the reduction inline.
   * Token reduction is therefore deferred to the next turn.
   */
  protected async compactByNative(
    sessionId: string,
    options?: { reason?: CompactTrigger },
  ): Promise<CompactResult> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new AdapterError(
        `Session ${sessionId} not found`,
        this.name,
        ErrorCode.AGENT_SESSION_NOT_FOUND,
      )
    }

    // Mark this session so the next query() call enables auto-compact.
    // Keep the flag set across multiple queries — the SDK may compact incrementally.
    this.autoCompactEnabledFor.add(sessionId)

    const buffer = this.sessionOutputBuffers.get(sessionId) ?? []
    const before = estimateTokens(buffer.join('\n'))
    const startedAt = Date.now()

    return {
      sessionId,
      strategy: 'native',
      trigger: options?.reason ?? 'manual',
      tokensBefore: before,
      tokensAfter: before, // reduction deferred — SDK will handle on next query
      summary: '(deferred — SDK auto-compact enabled for next turn)',
      startedAt,
      durationMs: Date.now() - startedAt,
    }
  }
}
