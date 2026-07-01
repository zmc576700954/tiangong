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

import { z } from 'zod'
import { BaseAdapter, DISPATCH_SUBAGENT_TOOL_NAME } from './base'
import { generateId } from '../shared/env'
import type {
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  CompactResult,
  CompactTrigger,
  SubagentInvokeArgs,
} from '@shared/types'
import { AdapterError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import { estimateTokens } from '../shared/token-utils'

import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'

type QueryFn = typeof ClaudeAgentSdk.query
type CreateSdkMcpServerFn = typeof ClaudeAgentSdk.createSdkMcpServer
type McpServerConfig = ReturnType<CreateSdkMcpServerFn>

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
  private sdkCreateMcpServer: CreateSdkMcpServerFn | null = null
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
      this.sdkCreateMcpServer = mod.createSdkMcpServer
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
    // SDK adapter: session persists across commands for multi-turn continuity.
    // Start the idle reaper so the session is reclaimed if the caller never calls
    // terminateSession (mirrors the pattern in CodexAdapter and McpAdapter).
    this.resetIdleReaper(sessionId)
    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
    const sessionId = session.id
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

      // Phase 4: register dispatch_subagent tool via in-process MCP server
      // when SubagentManager has been injected.
      let mcpServers: Record<string, McpServerConfig> | undefined
      if (this.subagentManager && this.sdkCreateMcpServer) {
        const dispatchTool = {
          name: DISPATCH_SUBAGENT_TOOL_NAME,
          description:
            'Spawn an ephemeral subagent for a focused task. Multiple calls may be issued in one turn to run in parallel. The subagent runs with a constrained tool set and file scope; its final output is returned to you as the tool result.',
          inputSchema: {
            agent_type: z
              .enum(['explore', 'implement', 'review', 'fix', 'general'])
              .describe('Which subagent type to spawn.'),
            description: z.string().describe('A 3-5 word label for the task.'),
            prompt: z.string().describe('Full task instructions. The subagent only sees this text.'),
            adapter_name: z.string().optional().describe('Optional adapter override.'),
            node_id: z.string().optional().describe('Optional canvas node binding.'),
            allowed_files: z
              .array(z.string())
              .optional()
              .describe('Optional file allow-list.'),
          },
          handler: async (rawArgs: { [x: string]: unknown }) => {
            const args = rawArgs as {
              agent_type: string
              description: string
              prompt: string
              adapter_name?: string
              node_id?: string
              allowed_files?: string[]
            }
            if (!this.subagentManager) {
              return {
                content: [{ type: 'text' as const, text: 'Subagent dispatch is not available.' }],
              }
            }
            try {
              const result = await this.subagentManager.invoke({
                parentSessionId: sessionId,
                agentType: args.agent_type,
                description: args.description,
                prompt: args.prompt,
                adapterName: args.adapter_name,
                nodeId: args.node_id,
                allowedFiles: args.allowed_files,
              } as SubagentInvokeArgs)
              return {
                content: [{ type: 'text' as const, text: result.resultText }],
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              return {
                content: [{ type: 'text' as const, text: `Subagent failed: ${errMsg}` }],
                isError: true,
              }
            }
          },
        }

        mcpServers = {
          bizgraph: this.sdkCreateMcpServer({
            name: 'bizgraph',
            version: '1.0.0',
            tools: [dispatchTool],
          }),
        }
      }

      // Phase 4: when running as a CHILD session, constrain the SDK's built-in tools
      // to the agent type's allowed set.
      let toolsOption: string[] | undefined
      const allowedTools = session.config.subagentAllowedTools
      if (allowedTools && allowedTools !== '*' && Array.isArray(allowedTools)) {
        toolsOption = allowedTools
      }

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
          ...(mcpServers ? { mcpServers } : {}),
          ...(toolsOption ? { tools: toolsOption } : {}),
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
                      this.emitOutputForSession(sessionId, {
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
                this.emitOutputForSession(sessionId, {
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
            this.emitOutputForSession(sessionId, {
              type: 'complete',
              data: message.result || 'Completed',
              timestamp: Date.now(),
            })
            // Reset idle reaper after each successful turn so the session is not
            // reclaimed while still in active multi-turn use (mirrors CodexAdapter).
            this.resetIdleReaper(sessionId)
          } else {
            const errorText =
              (message.errors.length > 0 ? message.errors.join('\n') : undefined) ??
              'Agent execution failed'
            this.emitOutputForSession(sessionId, {
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
        this.emitOutputForSession(sessionId, {
          type: 'complete',
          data: 'Session cancelled by user',
          timestamp: Date.now(),
        })
      } else {
        this.emitOutputForSession(sessionId, {
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
      tokensAfter: -1, // deferred — actual count unknown until next turn
      summary: '(deferred — SDK auto-compact enabled for next turn)',
      startedAt,
      durationMs: Date.now() - startedAt,
      deferred: true,
    }
  }
}
