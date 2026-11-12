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
import { spawn, type ChildProcess } from 'node:child_process'
import { BaseAdapter, DISPATCH_SUBAGENT_TOOL_NAME } from './base'
import { resolveModelForAdapter } from './model-selection'
import { READONLY_TOOLS } from '@shared/readonly-tools'
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
import { getSandboxCapability, sandboxLaunch } from '../shared/sandbox'

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

/** 进程级终止宽限期：SIGTERM 后等这么久仍存活才升级 SIGKILL。 */
const TERMINATE_TERM_GRACE_MS = 1500
const TERMINATE_KILL_GRACE_MS = 2000

/** 等待子进程真实退出；超时返回 false（调用方据此升级信号并记录残留风险）。 */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
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
  /**
   * SDK 由本适配器 spawn 时保存真实子进程句柄。`terminateSession` 的
   * 进程级终止必须拿到它；基类的 `processes` 只覆盖非 SDK spawn 路径。
   */
  private activeChildren = new Map<string, { child: ChildProcess; supervised: boolean }>()
  /** 取消时已请求 abort、但没有子进程句柄的会话：terminate 时必须显式记残留风险。 */
  private abortWithoutHandle = new Set<string>()
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
    // 只读会话：同样要关掉外部 MCP 与文件级 settings。
    //
    // SDK 的 `tools` 白名单**只管内置工具**，管不到 MCP 工具（sdk.d.ts:1630-1641）：
    // 用户配的 filesystem MCP、项目 .mcp.json、或设置里的 command hook
    // （sdk.d.ts:6923-6946，能独立执行 shell）都能在只读会话里写文件。
    // 所以只读会话必须：
    // - strictMcpConfig: true → 只用 mcpServers 选项里显式传入的 server
    //   （= BizGraph 自己的 dispatch_subagent），忽略项目 .mcp.json / 用户设置 / 插件；
    // - settingSources: [] → 不加载 user/project/local 的 settings.json（无 hook）。
    //
    // 注意：strictMcpConfig **不影响** mcpServers 选项里的 server（sdk.d.ts:2293-2299），
    // 所以 dispatch_subagent 仍然可用 —— 它是 BizGraph 自己的 in-process MCP server，
    // 不是「外部配置的 MCP」。子会话的只读保证由父会话的 readOnly 继承保证
    // （子会话展开 parentConfig，见 subagent-manager.ts 的 _runInvocation）。
    const readOnly = session.config.readOnly === true

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
      if (transparent) {
        // SDK 语义：tools: [] = 禁用全部内置工具（Read / Write / Edit / Bash …）。
        // 透明转发的远端调用方只应拿到模型回答，拿不到本机文件与 shell。
        //
        // **必须排在 readOnly 之前**：A2A 入站会话也是空的 allowedFiles → 会被推导
        // 成只读；若先命中只读分支，远端调用方就多拿到了本机 Read/Glob/Grep 与
        // **WebFetch（出网）** —— 那违反了 CLAUDE.md Boundaries §3 的透明转发边界。
        toolsOption = []
      } else if (session.config.readOnly) {
        // 只读会话：只放行读与查，**拿不到任何能改文件或执行命令的工具**。
        // 若同时是子代理（有自己的 allowedTools），取两者交集 ——
        // 否则子代理被允许的 Edit/Write 会破坏父会话的只读保证。
        const readonly = [...READONLY_TOOLS]
        toolsOption =
          allowedTools && allowedTools !== '*' && Array.isArray(allowedTools)
            ? readonly.filter((t) => allowedTools.includes(t))
            : readonly
      } else if (allowedTools && allowedTools !== '*' && Array.isArray(allowedTools)) {
        toolsOption = allowedTools
      }

      const approvalHooks = this.turnApprovalHooks.get(session.id)

      const queryIter = query({
        // 每轮上下文 + 用户请求进 user turn；稳定前缀走 systemPrompt 通道。
        // 用户请求只出现一次 —— 它不进 stable 段。
        prompt: [turnContext, commandPrompt].filter((s) => !!s && s.length > 0).join('\n\n'),
        options: {
          // 必须把本地 controller 交给 SDK：否则 abort() 只是改了一个没人监听的信号，
          // SDK 不会走 stdin EOF → 宽限 → spawn signal 的关闭路径，CLI 子进程会一直存活。
          abortController,
          // 透明转发：不下发 BizGraph 的 scope / memory / 项目上下文。
          ...(scopePrompt ? { systemPrompt: scopePrompt } : {}),
          cwd: session.config.workingDirectory,
          // 模型优先级：会话显式指定 > 按适配器拆分的默认（项目级/全局）> 兜底 sonnet。
          model: session.config.model ?? resolveModelForAdapter(settings, 'claude-code') ?? (settings.defaultModel || 'sonnet'),
          env: this.buildSessionEnv(session.id),
          // D5：Runtime 路径由我们 spawn，CLI 进入自有进程组（pgid = pid），
          // pid/pgid 当场可知并落库，跨重启回收不再依赖推断。
          // C3：沙箱可用时，旧路径也必须经同一 spawn 点套 profile（决策稿 §1.3）；
          // 旧路径保持 SDK 原本的 spawn 语义（非 detached），只有进程组行为不变。
          ...(this.isProcessSupervised(session.id) || getSandboxCapability().available
            ? {
                spawnClaudeCodeProcess: (spawnOptions: ClaudeAgentSdk.SpawnOptions) =>
                  this.spawnClaudeProcess(session.id, spawnOptions),
              }
            : {}),
          // 注入审批钩子时（kernel 或自由聊天旧路径）必须用 'default'，否则 SDK 直接按
          // acceptEdits 写文件，canUseTool 根本不会被调用（真机已验证）。
          // 未注入钩子的内部/有节点旧会话保持 acceptEdits（不在自由聊天审批范围）。
          // 只读会话同样必须是 'default'：acceptEdits 意味着无需确认即可写。
          permissionMode:
            approvalHooks?.canUseTool || transparent || session.config.readOnly ? 'default' : 'acceptEdits',
          // 透明转发：SDK isolation mode —— 不加载 ~/.claude 与项目的 settings.json，
          // 避免把用户侧的 hooks / MCP server / 权限规则带进远端可控的会话。
          ...(transparent ? { settingSources: [] } : {}),
          // 只读会话：同上，且额外忽略**外部**配置的 MCP server
          // （项目 .mcp.json / 用户设置 / 插件）—— strictMcpConfig 只保留
          // mcpServers 选项里显式传入的 server（即 BizGraph 自己的 dispatch_subagent）。
          // 没有这两项，用户配的 filesystem MCP 或设置里的 hook 就能在只读会话里写文件。
          ...(readOnly ? { settingSources: [], strictMcpConfig: true } : {}),
          ...(isTrustedNativeSessionId(session.config.resumeSessionId) ? { resume: session.config.resumeSessionId } : {}),
          ...(this.autoCompactEnabledFor.has(session.id) ? { autoCompactEnabled: true } : {}),
          ...(mcpServers ? { mcpServers } : {}),
          ...(toolsOption ? { tools: toolsOption } : {}),
          ...(approvalHooks?.canUseTool ? { canUseTool: approvalHooks.canUseTool } : {}),
          hooks: {
            // 只要注入了审批钩子就装 PreToolUse：写类工具必须先在这里强制 ask，
            // 才能确保 canUseTool 一定被调用（用户 settings.json 的 allow 会短路它）。
            // 旧路径只有 canUseTool、没有 onPreToolUse，同样需要这一层守卫。
            ...(approvalHooks
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
                            // 必须用会话工作目录：主进程 cwd 可能不在会话仓库内，
                            // 否则会漏读该仓库 .git/config 里的 textconv/diff.command 等执行型配置。
                            const decision = evaluateBashPolicy(bashCommandOf(toolInput), {
                              cwd: session.config.workingDirectory,
                              // C3：沙箱不可用时 allow 集整体退回 ask（fail-closed），
                              // 并把原因带到审批卡片/审计，回答「这台机器为什么在弹窗」。
                              sandboxAvailable: getSandboxCapability().available,
                              sandboxUnavailableReason: getSandboxCapability().reason,
                            })
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

                          await approvalHooks.onPreToolUse?.(toolName, toolInput, toolUseID)
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
      // 没有 pid 就做不到进程级终止：标记下来，由 doTerminate 显式记录残留风险，
      // 不允许静默当作已杀掉。
      if (!this.activeChildren.has(sessionId)) this.abortWithoutHandle.add(sessionId)
    }
    // Clear the auto-compact flag when the session ends; a new session must opt in again
    this.autoCompactEnabledFor.delete(sessionId)
  }

  /**
   * 进程级终止：先 SIGTERM（受控 spawn 时杀整个进程组），宽限后 SIGKILL，
   * 并等待子进程真实退出。SDK 的 abort 只保证「协议层收尾」，不能替代这一步。
   */
  protected async doTerminate(session: AgentSession, proc?: ChildProcess): Promise<void> {
    const tracked = this.activeChildren.get(session.id)
    const child = tracked?.child ?? proc
    const abortedWithoutHandle = this.abortWithoutHandle.delete(session.id)
    this.activeChildren.delete(session.id)
    if (!child) {
      if (abortedWithoutHandle) {
        this.logger.warn(
          `[terminate] session=${session.id} 取消时没有可用的子进程句柄：` +
            '只能依赖 SDK 的协议级关闭，存在进程残留风险（已显式记录）',
        )
      }
      return
    }
    const pid = child.pid
    if (!pid || child.exitCode !== null || child.signalCode !== null) return
    const supervised = tracked?.supervised === true
    const send = (signal: NodeJS.Signals): void => {
      try {
        // supervised：pgid === pid，整组回收（含 CLI 派生的工具子进程）。
        if (supervised) process.kill(-pid, signal)
        else child.kill(signal)
      } catch {
        // 组不存在 / 进程已退出：退回单进程 kill，失败则交给下一轮信号或退出监听。
        try {
          child.kill(signal)
        } catch {
          // 已退出
        }
      }
    }

    send('SIGTERM')
    if (await waitForChildExit(child, TERMINATE_TERM_GRACE_MS)) return
    this.logger.warn(
      `[terminate] session=${session.id} pid=${pid} SIGTERM 后 ${TERMINATE_TERM_GRACE_MS}ms 未退出，改发 SIGKILL`,
    )
    send('SIGKILL')
    if (await waitForChildExit(child, TERMINATE_KILL_GRACE_MS)) return
    this.logger.error(
      `[terminate] session=${session.id} pid=${pid} SIGKILL 后仍未退出：进程残留风险（已显式记录）`,
    )
  }

  /**
   * D5：受控 spawn。`detached: true` 让 CLI 成为自有进程组组长（pgid === pid），
   * 我们当场拿到 pid 并上报，Runtime 落库后即可跨重启按组回收。
   *
   * C3：无论受控还是旧路径，沙箱可用时都经 `sandboxLaunch()` 包 profile。
   * 旧路径刻意沿用 SDK 原本的非 detached spawn（不改变进程组语义）。
   */
  private spawnClaudeProcess(
    sessionId: string,
    options: ClaudeAgentSdk.SpawnOptions,
  ): ClaudeAgentSdk.SpawnedProcess {
    // C3：CLI 连同它执行的所有工具（Bash/写文件/hooks 子进程）都在同一 profile 内。
    // 沙箱不可用时原样 spawn；allow 集已在策略层退回 ask，不会出现「无沙箱仍免审」。
    const launch = sandboxLaunch('claude', {
      workspaceDir: options.cwd ?? process.cwd(),
      command: options.command,
      args: options.args,
    })
    if (launch.sandboxed) {
      this.logger.info(`claude CLI 以沙箱 profile 启动（${launch.profile?.workspace}）`)
    }
    const supervised = this.isProcessSupervised(sessionId)
    const child = supervised
      ? spawnInOwnGroup(launch.command, launch.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
        })
      : spawn(launch.command, launch.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: options.signal,
        })
    // stderr 必须有消费者，否则管道写满会阻塞 CLI
    child.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug(`claude stderr: ${chunk.toString('utf-8').slice(0, 300)}`)
    })
    // 保存真实句柄：terminateSession 的进程级终止只能靠它，基类 processes 不覆盖 SDK 路径。
    this.activeChildren.set(sessionId, { child, supervised })
    const forget = (): void => {
      const current = this.activeChildren.get(sessionId)
      if (current?.child === child) this.activeChildren.delete(sessionId)
    }
    child.once('exit', forget)
    child.once('error', forget)
    if (supervised && child.pid) {
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
