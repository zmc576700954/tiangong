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
import { isTrustedNativeSessionId } from '@shared/native-session-id'
import { isWriteScopedTool } from '../agent/runtime/approval/gateway'
import { evaluateBashPolicy, type BashPolicyDecision } from '../agent/runtime/approval/bash-readonly'
import { humanizeAgentErrorText } from '@shared/agent-error-text'
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
import { SUBAGENT_AGENT_TYPE_PATTERN } from '@shared/types/a2a'

import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import { spawnInOwnGroup } from '../shared/process-supervisor'

type QueryFn = typeof ClaudeAgentSdk.query
type CreateSdkMcpServerFn = typeof ClaudeAgentSdk.createSdkMcpServer
type McpServerConfig = ReturnType<CreateSdkMcpServerFn>

/** Claude `result` 消息里的 usage 形状（SDK 未导出该类型，这里按协议取）。 */
export interface ClaudeUsageShape {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * 解析 Claude usage，四个维度都要。
 *
 * `cache_creation_input_tokens`（写缓存）此前被整段漏掉：当一轮只有写缓存、
 * input_tokens 为 0 时，旧代码直接不记用量，账本整轮缺失。
 * 返回值 null 表示「四个维度全为 0」，即确实没有可记账的用量。
 */
export function parseClaudeUsage(raw: ClaudeUsageShape): {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
} | null {
  const inputTokens = raw.input_tokens ?? 0
  const outputTokens = raw.output_tokens ?? 0
  const cachedInputTokens = raw.cache_read_input_tokens ?? 0
  const cacheCreationInputTokens = raw.cache_creation_input_tokens ?? 0
  if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0 && cacheCreationInputTokens === 0) {
    return null
  }
  return { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens }
}

/**
 * D4：由 Runtime Driver 注入的轮次级审批钩子。
 * 只影响本 session 当前轮次；不设置时适配器行为与旧路径完全一致。
 */
export interface ClaudeTurnApprovalHooks {
  canUseTool?: ClaudeAgentSdk.CanUseTool
  onPreToolUse?: (toolName: string, toolInput: Record<string, unknown>, toolUseId?: string) => void | Promise<void>
  /**
   * Bash 只读白名单决策（M1/P3）：PreToolUse 阶段由我们的规则得出 allow/ask/deny，
   * 这里回调给 Runtime 记录审计（命中哪条规则 / 被哪条危险模式拦下）。
   */
  onBashPolicy?: (decision: BashPolicyDecision, toolUseId?: string) => void | Promise<void>
}

/** Claude CLI 的 shell 工具名（Bash）。 */
function isBashTool(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'bash'
}

/** Bash 工具参数里的命令字符串。 */
function bashCommandOf(toolInput: Record<string, unknown>): unknown {
  return toolInput.command
}

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
  /** D4：轮次级审批钩子（按 session 注入，轮次结束即清空） */
  private turnApprovalHooks = new Map<string, ClaudeTurnApprovalHooks>()

  /** Runtime Driver 调用；传 null 清除。旧路径不会调用。 */
  setTurnApprovalHooks(sessionId: string, hooks: ClaudeTurnApprovalHooks | null): void {
    if (hooks) {
      this.turnApprovalHooks.set(sessionId, hooks)
    } else {
      this.turnApprovalHooks.delete(sessionId)
    }
  }

  /**
   * SDK 多轮适配器：由 BaseAdapter 自动托管空闲回收定时器。
   * registerSession / sendCommand 处基类会自动 arm / re-arm，无需在此手动调用。
   */
  protected get autoManageIdleReaper(): boolean {
    return true
  }

  private sdkQuery: QueryFn | null = null
  private sdkCreateMcpServer: CreateSdkMcpServerFn | null = null
  private sdkLoadAttempted = false
  private activeQueries = new Map<string, { abort: () => void }>()
  /** Sessions flagged for auto-compaction on the next query() call */
  private autoCompactEnabledFor = new Set<string>()
  /** M1：每个 session 最近一条 assistant 消息的 model（result 消息不带 model，计价用） */
  private lastModelBySession = new Map<string, string>()

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
    // Idle reaper is armed automatically by BaseAdapter.registerSession (see
    // autoManageIdleReaper) so orphan sessions are still reclaimed.
    return session
  }

  /** Claude Code 支持 `--resume <conversation id>`，重启后可用原生续接。 */
  supportsNativeResume(): boolean {
    return true
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
    const turnContext = this.buildTurnContext(session)
    const commandPrompt = this.buildCommandPromptForSession(session, command)
    // 透明转发会话（A2A 入站）：远端调用方不应能借本机 CLI 读文件、跑 shell，
    // 或派生本地 subagent。下文据此关闭 MCP server、内置工具与文件级 settings。
    const transparent = session.config.transparentForward === true

    const abortController = new AbortController()
    this.activeQueries.set(session.id, { abort: () => abortController.abort() })

    // sessionEnded 只发一次：结果消息的错误通道与 catch 分支都可能触发，
    // 重复发会让恢复器跑两遍。
    let sessionEndedEmitted = false
    const emitSessionEndedOnce = () => {
      if (sessionEndedEmitted) return
      sessionEndedEmitted = true
      this.emit('sessionEnded', sessionId, 'error', null)
    }

    try {
      const { readSettings } = await import('../settings')
      const settings = await readSettings()

      // Phase 4: register dispatch_subagent tool via in-process MCP server
      // when SubagentManager has been injected.
      let mcpServers: Record<string, McpServerConfig> | undefined
      if (!transparent && this.subagentManager && this.sdkCreateMcpServer) {
        const dispatchTool = {
          name: DISPATCH_SUBAGENT_TOOL_NAME,
          description:
            'Spawn an ephemeral subagent for a focused task. Multiple calls may be issued in one turn to run in parallel. The subagent runs with a constrained tool set and file scope; its final output is returned to you as the tool result.',
          inputSchema: {
            agent_type: z
              .string()
              .regex(new RegExp(SUBAGENT_AGENT_TYPE_PATTERN), 'agent_type must be a built-in/custom type, "recipe:<id>" (Recipe workflow), or "a2a:<name>" (A2A remote agent)')
              .describe('Built-in/custom subagent type, "recipe:<id>" for a Recipe workflow, or "a2a:<name>" for an A2A remote agent.'),
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
      } else if (transparent) {
        // SDK 语义：tools: [] = 禁用全部内置工具（Read / Write / Edit / Bash …）。
        // 透明转发的远端调用方只应拿到模型回答，拿不到本机文件与 shell。
        toolsOption = []
      }

      const approvalHooks = this.turnApprovalHooks.get(session.id)

      const queryIter = query({
        // 每轮上下文 + 用户请求进 user turn；稳定前缀走 systemPrompt 通道。
        // 用户请求只出现一次 —— 它不进 stable 段。
        prompt: [turnContext, commandPrompt].filter((s) => !!s && s.length > 0).join('\n\n'),
        options: {
          // 透明转发：不下发 BizGraph 的 scope / memory / 项目上下文。
          ...(scopePrompt ? { systemPrompt: scopePrompt } : {}),
          cwd: session.config.workingDirectory,
          model: settings.defaultModel || 'sonnet',
          env: this.buildSessionEnv(session.id),
          // D5：Runtime 路径由我们 spawn，CLI 进入自有进程组（pgid = pid），
          // pid/pgid 当场可知并落库，跨重启回收不再依赖推断。
          ...(this.isProcessSupervised(session.id)
            ? {
                spawnClaudeCodeProcess: (spawnOptions: ClaudeAgentSdk.SpawnOptions) =>
                  this.spawnSupervisedClaude(session.id, spawnOptions),
              }
            : {}),
          // Kernel 路径注入审批钩子时必须用 'default'，否则 SDK 直接按 acceptEdits 写文件，
          // canUseTool 根本不会被调用（真机已验证）。旧路径无钩子，保持 acceptEdits 不变。
          permissionMode: approvalHooks?.canUseTool ? 'default' : transparent ? 'default' : 'acceptEdits',
          // 透明转发：SDK isolation mode —— 不加载 ~/.claude 与项目的 settings.json，
          // 避免把用户侧的 hooks / MCP server / 权限规则带进远端可控的会话。
          ...(transparent ? { settingSources: [] } : {}),
          ...(isTrustedNativeSessionId(session.config.resumeSessionId) ? { resume: session.config.resumeSessionId } : {}),
          ...(this.autoCompactEnabledFor.has(session.id) ? { autoCompactEnabled: true } : {}),
          ...(mcpServers ? { mcpServers } : {}),
          ...(toolsOption ? { tools: toolsOption } : {}),
          ...(approvalHooks?.canUseTool ? { canUseTool: approvalHooks.canUseTool } : {}),
          hooks: {
            ...(approvalHooks?.onPreToolUse
              ? {
                  PreToolUse: [
                    {
                      matcher: '*',
                      hooks: [
                        async (input: unknown, toolUseID: string | undefined) => {
                          const hookInput =
                            typeof input === 'object' && input !== null
                              ? (input as Record<string, unknown>)
                              : {}
                          const toolName = typeof hookInput.tool_name === 'string' ? hookInput.tool_name : ''
                          const toolInput =
                            typeof hookInput.tool_input === 'object' && hookInput.tool_input !== null
                              ? (hookInput.tool_input as Record<string, unknown>)
                              : {}

                          // P3：Bash 走我们自己的两档策略，不再把放行判断交给 SDK。
                          // allow → 免弹执行；ask → 强制回到我们的审批网关（用户决定）；
                          // blocked-empty（唯一例外：空命令）→ deny，因为没有内容可审批。
                          if (isBashTool(toolName)) {
                            const decision = evaluateBashPolicy(bashCommandOf(toolInput))
                            // 审计要按 step 关联：优先用 hook 回调的 toolUseID，
                            // 缺失时回退到 hook 输入里的 tool_use_id（两者都缺则无法归属）。
                            const toolUseId =
                              toolUseID ?? (typeof hookInput.tool_use_id === 'string' ? hookInput.tool_use_id : undefined)
                            await approvalHooks.onBashPolicy?.(decision, toolUseId)
                            return {
                              hookSpecificOutput: {
                                hookEventName: 'PreToolUse' as const,
                                permissionDecision:
                                  decision.decision === 'blocked-empty' ? 'deny' : decision.decision,
                                permissionDecisionReason: `BizGraph bash-policy(${decision.rule}/${decision.risk}): ${decision.reason}`,
                              },
                            }
                          }

                          await approvalHooks.onPreToolUse!(toolName, toolInput, toolUseID)
                          // 强制写前审批：用户 `~/.claude/settings.json` 的
                          // `permissions.allow`（如 "Write"）会让 CLI 直接执行工具、
                          // 根本不调用 canUseTool，从而绕过我们的网关（已实测复现）。
                          // PreToolUse hook 不受 allow 规则短路，返回 'ask' 会强制
                          // CLI 回到 canUseTool，由我们的网关/会话级授权最终决定。
                          return isWriteScopedTool(toolName)
                            ? {
                                hookSpecificOutput: {
                                  hookEventName: 'PreToolUse' as const,
                                  permissionDecision: 'ask' as const,
                                  permissionDecisionReason:
                                    'BizGraph policy: write tools always require host approval',
                                },
                              }
                            : {}
                        },
                      ],
                    },
                  ],
                }
              : {}),
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
        // D3：只读旁路，Driver 用它做逐消息归一化；旧路径不订阅时无副作用
        this.emitRawEvent(sessionId, 'claude', message)

        if (message.type === 'system' && message.subtype === 'init') {
          // SDK 管理的 session_id，用于多轮续接
          session.config.resumeSessionId = message.session_id
          continue
        }

        if (message.type === 'assistant') {
          if (isAssistantMessage(message.message)) {
            // 计价维度：result 消息不带 model，从 assistant 消息缓存（M1）
            const model = (message.message as { model?: unknown }).model
            if (typeof model === 'string' && model) this.lastModelBySession.set(sessionId, model)
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
          // Report authoritative token usage（M1：全量真实用量 + 模型，供 UsageLedger 计价落库）
          if (message.usage) {
            const parsed = parseClaudeUsage(message.usage)
            if (parsed) {
              this.reportUsage(session.id, parsed.inputTokens, undefined, {
                outputTokens: parsed.outputTokens,
                cachedInputTokens: parsed.cachedInputTokens,
                cacheCreationInputTokens: parsed.cacheCreationInputTokens,
                model: this.lastModelBySession.get(sessionId),
                source: 'provider',
              })
            }
          }
          // SDK 有两层失败信号：subtype 与 is_error。subtype='success' 但 is_error=true
          // 仍然是失败 —— 只看 subtype 会把失败当成功投给渲染层。
          if (message.subtype === 'success' && message.is_error !== true) {
            this.emitOutputForSession(sessionId, {
              type: 'complete',
              data: message.result || 'Completed',
              timestamp: Date.now(),
            })
            // Idle reaper is re-armed automatically by BaseAdapter.sendCommand on return.
          } else {
            // errors 数组可能缺失（不同 SDK 版本 / 不同生产者）—— 按运行时形状取。
            // 直接读 .length 会在取值时抛异常，把真实失败原因替换成 "Cannot read ..."。
            const errors: string[] =
              message.subtype !== 'success' && Array.isArray(message.errors)
                ? message.errors
                : []
            let errorText = errors.join('\n')
            if (!errorText && message.subtype === 'success') {
              // subtype=success 但 is_error=true —— 失败原因在 result 里
              errorText = message.result || ''
            }
            if (!errorText) errorText = 'Agent execution failed'
            this.emitOutputForSession(sessionId, {
              type: 'error',
              data: humanizeAgentErrorText(errorText),
              timestamp: Date.now(),
              errorCode: 'AGENT_CRASH',
            })
            // SDK 错误 = 会话异常终止。必须发 sessionEnded，否则恢复 / 回退 / Phase B
            // 记忆管线整条链路不可达（此前只有 catch 分支发）。
            emitSessionEndedOnce()
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
          data: humanizeAgentErrorText(`SDK error: ${msg}`),
          timestamp: Date.now(),
          errorCode: 'AGENT_CRASH',
        })
        // SDK 错误 = 会话异常终止。必须发 sessionEnded，否则恢复 / 回退 / Phase B 记忆管线整条链路不可达。
        emitSessionEndedOnce()
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
   * D5：受控 spawn。`detached: true` 让 CLI 成为自有进程组组长（pgid === pid），
   * 我们当场拿到 pid 并上报，Runtime 落库后即可跨重启按组回收。
   */
  private spawnSupervisedClaude(
    sessionId: string,
    options: ClaudeAgentSdk.SpawnOptions,
  ): ClaudeAgentSdk.SpawnedProcess {
    const child = spawnInOwnGroup(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    })
    // stderr 必须有消费者，否则管道写满会阻塞 CLI
    child.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug(`claude stderr: ${chunk.toString('utf-8').slice(0, 300)}`)
    })
    if (child.pid) {
      this.emitProcessSpawn(sessionId, { pid: child.pid, pgid: child.pid })
    }
    return child as unknown as ClaudeAgentSdk.SpawnedProcess
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
