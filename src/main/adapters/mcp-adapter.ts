/**
 * MCP / API Fallback Adapter
 *
 * When CLI agents (Claude Code, Codex, OpenCode) are not installed,
 * this adapter acts as a fallback using:
 * 1. Direct LLM API calls (Anthropic, OpenAI, DeepSeek, Gemini)
 * 2. Optional MCP servers for enhanced tool use
 *
 * Reference: cc-switch unified configuration pattern
 */

import {
  BaseAdapter,
  DISPATCH_SUBAGENT_TOOL_NAME,
  DISPATCH_SUBAGENT_TOOL_SCHEMA,
} from './base'
import { McpClient } from '../mcp/client'
import { generateId } from '../shared/env'
import type { ChildProcess } from 'node:child_process'
import type {
  AgentSession,
  AgentSessionConfig,
  AgentCommand,
  ApiKeyConfig,
  CompactResult,
  CompactTrigger,
} from '@shared/types'
import { readSettings } from '../settings'
import { AdapterError, ErrorCode } from '../errors'
import { estimateTokens } from '../shared/token-utils'

// ============================================
// Tool Use 类型定义
// ============================================

/** 通用 Tool 格式（与 MCP McpTool 对应） */
interface UnifiedTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** LLM 请求调用的 tool */
interface UnifiedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Tool 执行结果 */
interface ToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

/** 支持 Tool Use 的 LLM 消息格式 */
interface RichLlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: UnifiedToolCall[]
  toolResults?: ToolResult[]
}

/** LLM 输入/输出 token 使用统计（Anthropic / OpenAI 兼容字段） */
interface LlmUsage {
  input_tokens?: number
  output_tokens?: number
  prompt_tokens?: number
  completion_tokens?: number
}

/** LLM 结构化响应 */
interface LlmResponse {
  text: string
  toolCalls: UnifiedToolCall[]
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other'
  usage?: LlmUsage
}

// ============================================
// Response Parsers（独立导出，便于单元测试）
// ============================================

/** 解析 Anthropic Messages API 响应 */
export function parseAnthropicResponse(data: unknown): LlmResponse {
  const d = data as Record<string, unknown>
  if (!d || !Array.isArray(d.content)) {
    throw new AdapterError('Anthropic API returned unexpected response shape', 'mcp')
  }
  const content = d.content as Array<Record<string, unknown>>
  const stopReason = d.stop_reason as string | undefined
  const textParts: string[] = []
  const toolCalls: UnifiedToolCall[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      toolCalls.push({ id: block.id, name: block.name, arguments: (block.input as Record<string, unknown>) ?? {} })
    }
  }
  const usage = d.usage as { input_tokens?: number; output_tokens?: number } | undefined
  return {
    text: textParts.join('\n'),
    toolCalls,
    stopReason: stopReason === 'tool_use' ? 'tool_use' : 'end_turn',
    usage: usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } : undefined,
  }
}

/** 解析 OpenAI Chat Completions API 响应 */
export function parseOpenAiResponse(data: unknown): LlmResponse {
  const d = data as Record<string, unknown>
  if (!d || !Array.isArray(d.choices)) {
    throw new AdapterError('OpenAI API returned unexpected response shape', 'mcp')
  }
  const choices = d.choices as Array<Record<string, unknown>>
  const msg = (choices[0]?.message ?? {}) as Record<string, unknown>
  const toolCallsRaw = (msg.tool_calls ?? []) as Array<Record<string, unknown>>
  const toolCalls: UnifiedToolCall[] = []
  for (const tc of toolCallsRaw) {
    if (typeof tc.id !== 'string') continue
    const fn = (tc.function ?? {}) as Record<string, unknown>
    const name = typeof fn.name === 'string' ? fn.name : ''
    let args: Record<string, unknown> = {}
    if (typeof fn.arguments === 'string') {
      try { args = JSON.parse(fn.arguments) } catch { /* keep empty */ }
    }
    if (name) toolCalls.push({ id: tc.id, name, arguments: args })
  }
  const usage = d.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    stopReason: choices[0]?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    usage: usage ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } : undefined,
  }
}

/** 解析 Gemini GenerateContent API 响应 */
export function parseGeminiResponse(data: unknown): LlmResponse {
  const d = data as Record<string, unknown>
  if (!d) {
    throw new AdapterError('Gemini API returned empty response', 'mcp')
  }
  const candidates = d.candidates as Array<Record<string, unknown>> | undefined
  const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined
  const text = typeof parts?.[0]?.text === 'string' ? parts[0].text : ''
  const meta = d.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn' as const,
    usage: meta ? { prompt_tokens: meta.promptTokenCount, completion_tokens: meta.candidatesTokenCount } : undefined,
  }
}

// ============================================
// Provider 配置（抽象 LLM 调用差异 + Tool Use）
// ============================================

interface ProviderConfig {
  defaultModel: string
  /** 是否支持结构化 tool use */
  supportsTools: boolean
  buildUrl: (baseUrl: string | undefined, key: string, model: string) => string
  buildHeaders: (key: string, baseUrl: string | undefined) => Record<string, string>
  /** 构建请求体（支持可选 tools） */
  buildBody: (messages: RichLlmMessage[], model: string, tools?: UnifiedTool[]) => unknown
  /** 解析响应为结构化格式 */
  parseResponse: (data: unknown) => LlmResponse
}

/** Default model IDs per provider — update when newer models become stable */
const DEFAULT_MODELS = {
  anthropic: 'claude-3-5-sonnet-20241022',
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
  gemini: 'gemini-1.5-flash',
} as const

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  anthropic: {
    defaultModel: DEFAULT_MODELS.anthropic,
    supportsTools: true,
    buildUrl: (baseUrl) => baseUrl ? `${baseUrl}/v1/messages` : 'https://api.anthropic.com/v1/messages',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    buildBody: (messages, model, tools) => {
      const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
      const anthropicMessages = messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          // 普通文本消息
          if (!m.toolCalls && !m.toolResults) {
            return { role: m.role, content: m.content }
          }
          // assistant 的 tool_use 消息
          if (m.toolCalls) {
            const content: Array<Record<string, unknown>> = []
            if (m.content) {
              content.push({ type: 'text', text: m.content })
            }
            for (const tc of m.toolCalls) {
              content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
              })
            }
            return { role: 'assistant', content }
          }
          // tool result 消息 (role: 'tool' carries toolResults)
          if (m.toolResults) {
            return {
              role: 'user',
              content: m.toolResults.map((tr) => ({
                type: 'tool_result',
                tool_use_id: tr.toolCallId,
                content: tr.content,
                is_error: tr.isError ?? false,
              })),
            }
          }
          return { role: m.role, content: m.content }
        })

      const body: Record<string, unknown> = {
        model,
        max_tokens: 4096,
        system: systemMsg,
        messages: anthropicMessages,
      }
      if (tools && tools.length > 0) {
        body.tools = tools.map((t) => ({
          name: t.name,
          description: t.description ?? 'No description',
          input_schema: t.inputSchema ?? { type: 'object', properties: {} },
        }))
      }
      return body
    },
    parseResponse: parseAnthropicResponse,
  },
  openai: {
    defaultModel: DEFAULT_MODELS.openai,
    supportsTools: true,
    buildUrl: (baseUrl) => baseUrl ? `${baseUrl}/chat/completions` : 'https://api.openai.com/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (messages, model, tools) => {
      const openaiMessages = messages.map((m) => {
        if (m.role === 'tool') {
          // Each role:'tool' message carries one tool result with toolCallId
          const toolCallId = m.toolResults?.[0]?.toolCallId ?? ''
          return { role: 'tool', tool_call_id: toolCallId, content: m.content }
        }
        if (m.toolCalls) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }
        }
        return { role: m.role, content: m.content }
      })

      const body: Record<string, unknown> = { model, messages: openaiMessages }
      if (tools && tools.length > 0) {
        body.tools = tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description ?? 'No description',
            parameters: t.inputSchema ?? { type: 'object', properties: {} },
          },
        }))
        body.tool_choice = 'auto'
      }
      return body
    },
    parseResponse: parseOpenAiResponse,
  },
  deepseek: {
    defaultModel: DEFAULT_MODELS.deepseek,
    supportsTools: true,
    buildUrl: (baseUrl) => baseUrl ? `${baseUrl}/chat/completions` : 'https://api.deepseek.com/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }),
    // DeepSeek 兼容 OpenAI 格式
    buildBody: (messages, model, tools) => PROVIDER_CONFIGS.openai.buildBody(messages, model, tools),
    parseResponse: parseOpenAiResponse,
  },
  gemini: {
    defaultModel: DEFAULT_MODELS.gemini,
    supportsTools: false,
    buildUrl: (baseUrl, _key, model) => {
      const safeModel = encodeURIComponent(model)
      return baseUrl
        ? `${baseUrl}/models/${safeModel}:generateContent`
        : `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent`
    },
    buildHeaders: (key, _baseUrl) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    }),
    buildBody: (messages, _model) => {
      const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
      const userMsgs = messages.filter((m) => m.role !== 'system')
      const contents = userMsgs.map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      }))
      return {
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        contents,
      }
    },
    parseResponse: parseGeminiResponse,
  },
}

/** Tool Result 传回 LLM 的最大字符数，防止单个结果撑爆上下文窗口 */
const MAX_TOOL_RESULT_CHARS = 8000

/** MCP 会话空闲超时时间（30 分钟） */
const MCP_SESSION_TIMEOUT_MS = 30 * 60 * 1000

/** API 调用频率限制：每 10 秒最多 3 次，每分钟最多 10 次 */
const API_RATE_LIMIT_SHORT_WINDOW_MS = 10_000
const API_RATE_LIMIT_SHORT_MAX = 3
const API_RATE_LIMIT_LONG_WINDOW_MS = 60_000
const API_RATE_LIMIT_LONG_MAX = 10

interface ApiRateLimitEntry {
  timestamps: number[]
}

export class ApiRateLimiter {
  private entries = new Map<string, ApiRateLimitEntry>()

  check(sessionId: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now()
    const entry = this.entries.get(sessionId) ?? { timestamps: [] }

    // 清理过期的记录
    entry.timestamps = entry.timestamps.filter(
      (t) => now - t < API_RATE_LIMIT_LONG_WINDOW_MS,
    )

    // 检查长窗口限制（1 分钟）
    if (entry.timestamps.length >= API_RATE_LIMIT_LONG_MAX) {
      const oldest = entry.timestamps[0]
      return { allowed: false, retryAfterMs: API_RATE_LIMIT_LONG_WINDOW_MS - (now - oldest) }
    }

    // 检查短窗口限制（10 秒）
    const shortWindowTimestamps = entry.timestamps.filter(
      (t) => now - t < API_RATE_LIMIT_SHORT_WINDOW_MS,
    )
    if (shortWindowTimestamps.length >= API_RATE_LIMIT_SHORT_MAX) {
      const oldest = shortWindowTimestamps[0]
      return { allowed: false, retryAfterMs: API_RATE_LIMIT_SHORT_WINDOW_MS - (now - oldest) }
    }

    // 记录本次调用
    entry.timestamps.push(now)
    this.entries.set(sessionId, entry)
    return { allowed: true }
  }

  cleanup(sessionId: string): void {
    this.entries.delete(sessionId)
  }
}

/**
 * 根据 provider 匹配 API Key（独立函数，便于单元测试）
 * 使用前缀匹配而非 includes，减少误匹配风险
 */
export function resolveApiKey(apiKeys: ApiKeyConfig[], defaultModel?: string): ApiKeyConfig | undefined {
  // 优先级1：根据 defaultModel 名称推断 provider（使用前缀/精确匹配）
  if (defaultModel) {
    const model = defaultModel.toLowerCase()
    const providerMatchers: Array<{ provider: string; test: (m: string) => boolean }> = [
      { provider: 'anthropic', test: (m) => m.startsWith('claude') },
      { provider: 'openai', test: (m) => m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') },
      { provider: 'deepseek', test: (m) => m.startsWith('deepseek') },
      { provider: 'gemini', test: (m) => m.startsWith('gemini') },
    ]
    for (const { provider, test } of providerMatchers) {
      if (test(model)) {
        const found = apiKeys.find((k) => k.provider === provider && k.key.length > 0)
        if (found) return found
      }
    }
  }

  // 优先级2：返回第一个有对应 provider config 且 key 非空的 Key
  return apiKeys.find((k) => PROVIDER_CONFIGS[k.provider] !== undefined && k.key.length > 0)
}

export class McpAdapter extends BaseAdapter {
  readonly name = 'mcp'
  readonly version = '1.0.0'

  /**
   * SDK 多轮适配器：BaseAdapter 自动托管空闲回收定时器。
   * 使用 MCP_SESSION_TIMEOUT_MS 作为空闲窗口（30 分钟），通过 getIdleReaperMs 传给基类。
   * 这样 doSendCommand 里的所有 early-return 分支（缺 key、限流、断路器…）都不再需要
   * 手动 arm reaper —— 基类在 sendCommand 的 finally 里统一 re-arm。
   */
  protected get autoManageIdleReaper(): boolean {
    return true
  }

  protected getIdleReaperMs(): number {
    return MCP_SESSION_TIMEOUT_MS
  }

  private mcpClients = new Map<string, McpClient[]>()
  private apiRateLimiter = new ApiRateLimiter()
  /** MCP 服务器熔断器：防止连续失败导致重连风暴 */
  // 内联熔断器：MCP 专用，与 circuit-breaker.ts 的 AdapterCircuitBreaker 相比
  // 更轻量且直接耦合 MCP server 生命周期。若未来其他适配器也需要熔断，
  // 应统一迁移到 AdapterCircuitBreaker（含 half-open→closed 正式转换）。
  private circuitBreaker = new Map<string, { failures: number; lastFailureTime: number; state: 'closed' | 'open' | 'half-open' }>()
  private static readonly CB_FAILURE_THRESHOLD = 3
  private static readonly CB_OPEN_DURATION_MS = 30_000 // 30 秒冷却
  /** MCP 连接池：跨会话复用 MCP 客户端连接 */
  private connectionPool = new Map<string, { client: McpClient; refCount: number; lastUsed: number }>()
  private static readonly POOL_IDLE_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟空闲超时
  /** 连接池定期清理定时器 */
  private poolCleanupTimer?: ReturnType<typeof setInterval>

  async checkInstalled(): Promise<boolean> {
    // MCP adapter is "installed" if at least one API key is configured
    try {
      const settings = await readSettings()
      return settings.apiKeys.length > 0
    } catch {
      return false
    }
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionId = generateId('mcp')

    // Connect to enabled MCP servers
    const settings = await readSettings()
    const enabledServers = settings.mcpServers.filter((s) => s.enabled)
    const sessionClients: McpClient[] = []

    // 清理连接池中的空闲超时连接
    this.cleanupIdlePoolConnections()

    // 启动连接池定期清理定时器（仅启动一次）
    if (!this.poolCleanupTimer) {
      this.poolCleanupTimer = setInterval(() => this.cleanupIdlePoolConnections(), 5 * 60 * 1000)
      this.poolCleanupTimer.unref()
    }

    // 先注册会话，确保后续 emitOutput 能正确关联
    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config: structuredClone(config),
      startTime: Date.now(),
    }
    this.registerSession(session)
    this.pushOutputSession(sessionId)

    try {
      for (const server of enabledServers) {
        // 熔断器检查：跳过处于 open 状态的服务器
        if (this.isCircuitOpen(server.name)) {
          this.emitOutput({
            type: 'stderr',
            data: `MCP server ${server.name} circuit breaker open (cooling down), skipping`,
            timestamp: Date.now(),
          })
          continue
        }
        try {
          // 优先从连接池复用
          const pooled = this.connectionPool.get(server.name)
          if (pooled && pooled.client.isReady()) {
            pooled.refCount++
            pooled.lastUsed = Date.now()
            sessionClients.push(pooled.client)
            this.emitOutput({
              type: 'stdout',
              data: `MCP server reused from pool: ${server.name}`,
              timestamp: Date.now(),
            })
            continue
          }
          // 池中无可用连接，新建
          const client = new McpClient(server.command, server.args)
          await client.connect()
          this.recordCircuitResult(server.name, true)
          // 池槽写入策略：
          // 1. 无现存条目 → 直接写入。
          // 2. 现存条目已无引用（refCount <= 0） → 可安全替换。
          // 3. 现存条目有引用但客户端已死 (isReady() false) → 替换：
          //    死客户端无法服务新连接，持有其引用的旧会话在清理时会通过
          //    client-reference 匹配走非池化断开路径，不会影响引用计数。
          //    若不替换，池槽永久被死条目占据，所有新会话退化为私有连接，丧失复用。
          // 4. 现存条目有引用且客户端仍存活 → 保留：覆盖会丢失 refCount，
          //    旧 client 在清理时被误判为非池化而提前 disconnect（use-after-disconnect）。
          const existingEntry = this.connectionPool.get(server.name)
          const shouldPoolNewClient = !existingEntry
            || existingEntry.refCount <= 0
            || !existingEntry.client.isReady()
          if (shouldPoolNewClient) {
            this.connectionPool.set(server.name, { client, refCount: 1, lastUsed: Date.now() })
          }
          sessionClients.push(client)
          this.emitOutput({
            type: 'stdout',
            data: `MCP server connected: ${server.name}`,
            timestamp: Date.now(),
          })
        } catch (err) {
          this.recordCircuitResult(server.name, false)
          const msg = err instanceof Error ? err.message : String(err)
          this.emitOutput({
            type: 'stderr',
            data: `MCP server failed (${server.name}): ${msg}`,
            timestamp: Date.now(),
          })
        }
      }
    } finally {
      this.popOutputSession()
    }

    this.mcpClients.set(sessionId, sessionClients)

    // Idle reaper armed automatically by BaseAdapter.registerSession
    // (autoManageIdleReaper=true + getIdleReaperMs() → MCP_SESSION_TIMEOUT_MS).

    // Build scope prompt
    const scopePrompt = this.buildScopePrompt(config)

    this.pushOutputSession(sessionId)
    try {
      this.emitOutput({
        type: 'stdout',
        data: `MCP fallback session started.\n${scopePrompt}`,
        timestamp: Date.now(),
      })
    } finally {
      this.popOutputSession()
    }

    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand, _proc?: ChildProcess): Promise<void> {
    const sessionId = session.id
    // 空闲回收定时器的 clear/re-arm 由 BaseAdapter.sendCommand 统一在 doSendCommand
    // 前后处理（autoManageIdleReaper=true）——本方法所有 early-return 路径都会经过
    // 那里的 finally，因此无需在每个分支手动 restore。
    const settings = await readSettings()

    // W4-FIX: 根据 session config 或 settings.defaultModel 匹配 provider 的 API Key
    const apiKey = resolveApiKey(settings.apiKeys, settings.defaultModel)

    if (!apiKey) {
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: 'No API key configured. Please add an API key in Settings.',
        timestamp: Date.now(),
      })
      return
    }

    const typeLabels: Record<string, string> = {
      implement: 'Please implement the following',
      fix_bug: 'Please fix the following bug',
      refactor: 'Please refactor the following',
      add_test: 'Please add tests for the following',
    }

    const userPrompt = `${typeLabels[command.type] ?? 'Please complete the task'}:\n${command.description}`
    const systemPrompt = this.buildScopePromptForSession(session)

    // Gather MCP tools
    const clients = this.mcpClients.get(session.id) ?? []
    const mcpTools = clients.flatMap((c) => c.getTools())
    const providerConfig = PROVIDER_CONFIGS[apiKey.provider]
    const supportsTools = providerConfig?.supportsTools ?? false

    // Call LLM API via unified provider config
    try {
      // 检查 API 调用频率限制
      const rateCheck = this.apiRateLimiter.check(session.id)
      if (!rateCheck.allowed) {
        const retrySec = Math.ceil((rateCheck.retryAfterMs ?? 10_000) / 1000)
        this.emitOutputForSession(sessionId, {
          type: 'error',
          data: `API rate limit exceeded. Please wait ${retrySec}s before sending another message.`,
          timestamp: Date.now(),
        })
        return
      }

      let responseText: string

      if (supportsTools && (mcpTools.length > 0 || this.subagentManager)) {
        // 结构化 Tool Use 模式（Anthropic / OpenAI / DeepSeek）
        const tools: UnifiedTool[] = mcpTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }))

        // Append dispatch_subagent tool when SubagentManager is set
        if (this.subagentManager) {
          tools.unshift({
            name: DISPATCH_SUBAGENT_TOOL_NAME,
            description: DISPATCH_SUBAGENT_TOOL_SCHEMA.description,
            inputSchema: DISPATCH_SUBAGENT_TOOL_SCHEMA.input_schema as unknown as Record<string, unknown>,
          })
        }

        // Phase 4: subagentAllowedTools restriction is enforced for Claude Code's SDK tools
        // only. MCP adapter tools come from MCP server discovery and don't map 1:1 to
        // SubagentToolName. Phase 5+ will revisit if needed.

        const messages: RichLlmMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ]

        responseText = await this.executeToolUseLoop(
          session,
          apiKey,
          messages,
          tools,
          clients,
          settings.defaultModel,
        )
      } else {
        // 纯文本模式（Gemini 或不支持 tools 时）
        const toolDescriptions = mcpTools
          .map((t) => `- ${t.name}: ${t.description ?? 'No description'}`)
          .join('\n')
        const enhancedSystem = toolDescriptions
          ? `${systemPrompt}\n\n## Available MCP Tools\n${toolDescriptions}`
          : systemPrompt

        responseText = await this.callLlmUnified(
          apiKey.provider,
          apiKey.key,
          apiKey.baseUrl,
          [
            { role: 'system', content: enhancedSystem },
            { role: 'user', content: userPrompt },
          ],
          settings.defaultModel,
          session.id,
        )

        this.emitOutputForSession(sessionId, {
          type: 'stdout',
          data: responseText,
          timestamp: Date.now(),
        })
      }

      this.emitOutputForSession(sessionId, {
        type: 'complete',
        data: 'MCP session completed',
        timestamp: Date.now(),
      })
      // MCP adapter 维护连接池以支持多轮复用，单命令成功不应销毁会话。资源清理由显式
      // terminateSession 或共享 idle reaper 负责；后者由 BaseAdapter 在 sendCommand
      // 的 finally 中自动 re-arm，无活动窗口后 emit sessionEnded('idle') →
      // AgentManager 执行完整清理（含记忆管线）。
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutputForSession(sessionId, {
        type: 'error',
        data: `LLM API error: ${msg}`,
        timestamp: Date.now(),
      })
      // 错误仍需通知 AgentManager 以触发会话恢复/清理流程
      this.emit('sessionEnded', session.id, 'error', null)
    }
  }

  protected async doTerminate(_session: AgentSession, _proc?: ChildProcess): Promise<void> {
    this.cleanupMcpResources(_session.id)
    // MCP 适配器不在 this.processes 中注册进程（startSession 不传 proc 给 registerSession），
    // 因此 proc 始终为 undefined。显式调用 super 以确保基类未来增加清理逻辑时不被跳过。
    await super.doTerminate(_session, undefined)
  }

  /**
   * 清理 MCP 专属资源（连接、定时器、频率限制记录）
   * 不清理 sessions/processes 等基类管理的状态
   */
  private cleanupMcpResources(sessionId: string): void {
    // 空闲回收由共享 BaseAdapter.clearIdleReaper 负责（base.terminateSession 已调用），
    // 旧版自有 sessionTimers 已迁移到 resetIdleReaper/clearIdleReaper，这里无需额外操作。

    const clients = this.mcpClients.get(sessionId) ?? []
    for (const client of clients) {
      try {
        // 连接池模式：减引用计数，仍有其他会话使用时不断开
        let pooled = false
        for (const [, pooledEntry] of this.connectionPool) {
          if (pooledEntry.client === client) {
            pooledEntry.refCount--
            pooledEntry.lastUsed = Date.now()
            if (pooledEntry.refCount > 0) {
              pooled = true
            }
            break
          }
        }
        // 非池化连接或引用计数归零时断开
        if (!pooled) {
          client.disconnect().catch((err) => {
            this.logger.warn('Failed to disconnect MCP client:', err)
          })
        }
      } catch (err) {
        this.logger.warn('Error during session cleanup:', err)
      }
    }
    this.mcpClients.delete(sessionId)

    this.apiRateLimiter.cleanup(sessionId)
    // Also clean up the derived compact sidecar sessionId
    this.apiRateLimiter.cleanup(`${sessionId}:compact`)
  }

  /**
   * Dispose the adapter: stop the pool cleanup timer and disconnect all pooled clients.
   * Should be called when the application shuts down to prevent resource leaks.
   */
  dispose(): void {
    if (this.poolCleanupTimer) {
      clearInterval(this.poolCleanupTimer)
      this.poolCleanupTimer = undefined
    }
    for (const [, entry] of this.connectionPool) {
      entry.client.disconnect?.().catch(() => {})
    }
    this.connectionPool.clear()
  }

  // ============================================
  // 熔断器
  // ============================================

  /**
   * 检查 MCP 服务器熔断器是否处于 open 状态
   * open 状态时拒绝连接，等待冷却后进入 half-open 允许一次尝试
   */
  private isCircuitOpen(serverName: string): boolean {
    const cb = this.circuitBreaker.get(serverName)
    if (!cb || cb.state === 'closed') return false
    if (cb.state === 'open') {
      // 冷却期已过，转为 half-open 允许一次尝试
      if (Date.now() - cb.lastFailureTime > McpAdapter.CB_OPEN_DURATION_MS) {
        cb.state = 'half-open'
        return false
      }
      return true
    }
    // half-open: 允许一次尝试
    return false
  }

  /**
   * 记录熔断器结果：成功则关闭，失败则累计
   */
  private recordCircuitResult(serverName: string, success: boolean): void {
    let cb = this.circuitBreaker.get(serverName)
    if (!cb) {
      cb = { failures: 0, lastFailureTime: 0, state: 'closed' }
      this.circuitBreaker.set(serverName, cb)
    }
    if (success) {
      cb.failures = 0
      cb.state = 'closed'
    } else {
      cb.failures++
      cb.lastFailureTime = Date.now()
      if (cb.failures >= McpAdapter.CB_FAILURE_THRESHOLD) {
        cb.state = 'open'
      }
    }
  }

  /**
   * 清理连接池中空闲超时的连接（refCount=0 且 lastUsed 超过池空闲超时）
   */
  private cleanupIdlePoolConnections(): void {
    const now = Date.now()
    for (const [name, entry] of this.connectionPool) {
      if (entry.refCount <= 0 && now - entry.lastUsed > McpAdapter.POOL_IDLE_TIMEOUT_MS) {
        entry.client.disconnect().catch((err) => {
          this.logger.warn(`Failed to disconnect idle pooled MCP client (${name}):`, err)
        })
        this.connectionPool.delete(name)
      }
    }
  }

  // ============================================
  // 统一 LLM 调用（消除四份重复代码）
  // ============================================

  /**
   * 带超时的 fetch 请求封装
   * 默认 60 秒超时，防止请求挂死
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 60000,
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      return res
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AdapterError(`Request timeout after ${timeoutMs}ms`, this.name)
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * 统一的 LLM API 调用：返回结构化响应（支持 Tool Use）
   */
  private async callLlmWithToolSupport(
    provider: string,
    key: string,
    baseUrl: string | undefined,
    messages: RichLlmMessage[],
    tools?: UnifiedTool[],
    defaultModel?: string,
    sessionId?: string,
  ): Promise<LlmResponse> {
    const config = PROVIDER_CONFIGS[provider]
    if (!config) {
      throw new AdapterError(`Unsupported provider: ${provider}`, this.name)
    }

    const model = defaultModel ?? config.defaultModel
    const url = config.buildUrl(baseUrl, key, model)
    const headers = config.buildHeaders(key, baseUrl)
    const body = config.buildBody(messages, model, tools)

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      let text = '(unable to read response body)'
      try { text = await res.text() } catch { /* ignore */ }
      throw new AdapterError(`${provider} API error ${res.status}: ${text}`, this.name)
    }

    const data = await res.json()
    const parsed = config.parseResponse(data)

    // Report authoritative token usage to the AgentManager budget tracker
    if (sessionId && parsed.usage) {
      const inputTokens = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens ?? 0
      if (inputTokens > 0) {
        // Default to Claude's 200k context window; provider-specific limits can be wired later
        this.reportUsage(sessionId, inputTokens, 200_000)
      }
    }

    return parsed
  }

  /**
   * 向后兼容：纯文本 LLM 调用（无 Tool Use）
   */
  private async callLlmUnified(
    provider: string,
    key: string,
    baseUrl: string | undefined,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    defaultModel?: string,
    sessionId?: string,
  ): Promise<string> {
    const richMessages: RichLlmMessage[] = messages.map((m) => ({ ...m }))
    const response = await this.callLlmWithToolSupport(provider, key, baseUrl, richMessages, undefined, defaultModel, sessionId)
    return response.text
  }

  // ============================================
  // Tool Use 闭环执行
  // ============================================

  /**
   * 执行 Tool Use 循环：LLM → Tool Call → Tool Result → LLM → ...
   * @returns 最终文本响应
   */
  private async executeToolUseLoop(
    session: AgentSession,
    apiKey: ApiKeyConfig,
    messages: RichLlmMessage[],
    tools: UnifiedTool[],
    clients: McpClient[],
    defaultModel?: string,
  ): Promise<string> {
    const MAX_TOOL_ITERATIONS = 10
    let iterations = 0

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++

      // 检查频率限制
      const rateCheck = this.apiRateLimiter.check(session.id)
      if (!rateCheck.allowed) {
        const retrySec = Math.ceil((rateCheck.retryAfterMs ?? 10_000) / 1000)
        throw new AdapterError(`API rate limit exceeded. Wait ${retrySec}s.`, this.name)
      }

      const response = await this.callLlmWithToolSupport(
        apiKey.provider,
        apiKey.key,
        apiKey.baseUrl,
        messages,
        tools,
        defaultModel,
        session.id,
      )

      // 发送 LLM 的文本输出（如果有）
      if (response.text) {
        this.emitOutputForSession(session.id, {
          type: 'stdout',
          data: response.text,
          timestamp: Date.now(),
        })
      }

      // 如果没有 tool calls，循环结束
      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
        return response.text
      }

      // 执行 tool calls
      const toolResults: ToolResult[] = []
      for (const toolCall of response.toolCalls) {
        // Phase 4: Intercept dispatch_subagent — route to SubagentManager instead of MCP client
        if (toolCall.name === DISPATCH_SUBAGENT_TOOL_NAME && this.subagentManager) {
          const args = toolCall.arguments as Record<string, unknown>
          try {
            const result = await this.subagentManager.invoke({
              parentSessionId: session.id,
              agentType: String(args.agent_type ?? ''),
              description: String(args.description ?? ''),
              prompt: String(args.prompt ?? ''),
              adapterName: args.adapter_name ? String(args.adapter_name) : undefined,
              nodeId: args.node_id ? String(args.node_id) : undefined,
              allowedFiles: Array.isArray(args.allowed_files) ? (args.allowed_files as string[]) : undefined,
            })
            toolResults.push({
              toolCallId: toolCall.id,
              content: result.resultText,
            })
          } catch (err) {
            toolResults.push({
              toolCallId: toolCall.id,
              content: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            })
          }
          continue
        }

        const result = await this.executeMcpTool(clients, toolCall)
        toolResults.push(result)

        // 输出 tool 执行信息
        const statusIcon = result.isError ? '❌' : '✅'
        this.emitOutputForSession(session.id, {
          type: 'stdout',
          data: `${statusIcon} Tool: ${toolCall.name}\n${result.content.substring(0, 500)}`,
          timestamp: Date.now(),
        })
      }

      // 将 tool results 加入对话历史（截断过大内容防撑爆上下文）
      const truncatedRoute: ToolResult[] = toolResults.map((tr) => {
        if (tr.content.length <= MAX_TOOL_RESULT_CHARS) return tr
        return {
          ...tr,
          content: tr.content.substring(0, MAX_TOOL_RESULT_CHARS)
            + `\n\n[Truncated: original ${tr.content.length} chars]`,
        }
      })
      messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
      })
      // Push tool results as individual role:'tool' messages for OpenAI/DeepSeek compatibility
      for (const tr of truncatedRoute) {
        messages.push({
          role: 'tool',
          content: tr.content,
          toolResults: [tr],
        })
      }
    }

    return '[Max tool iterations reached]'
  }

  /**
   * 通过 MCP Client 执行单个 tool call
   */
  private async executeMcpTool(
    clients: McpClient[],
    toolCall: UnifiedToolCall,
  ): Promise<ToolResult> {
    for (const client of clients) {
      const availableTools = client.getTools()
      if (availableTools.some((t) => t.name === toolCall.name)) {
        try {
          const result = await client.callTool(toolCall.name, toolCall.arguments)
          return {
            toolCallId: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { toolCallId: toolCall.id, content: `Tool error: ${msg}`, isError: true }
        }
      }
    }
    return { toolCallId: toolCall.id, content: `Tool not found: ${toolCall.name}`, isError: true }
  }

  // ============================================
  // Phase 3: LLM-based context compaction
  // ============================================

  /**
   * LLM-based compaction: send the session output buffer to a cheap model for
   * summarisation and store the result as `session.config.contextSummary` so the
   * next turn's scope prompt re-injects it. On failure the orchestrator falls
   * back to `summary-rewrite`.
   */
  protected async compactByLlm(
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
    const buffer = this.sessionOutputBuffers.get(sessionId) ?? []
    const fullText = buffer.join('\n')
    // Head+tail strategy: preserve early decisions and recent context,
    // rather than only taking the front and losing early critical info.
    const MAX_CHARS = 64_000
    const conversationText = fullText.length > MAX_CHARS
      ? fullText.slice(0, MAX_CHARS / 2) + '\n\n[... truncated middle ...]\n\n' + fullText.slice(-(MAX_CHARS / 2))
      : fullText
    const before = estimateTokens(conversationText)
    const startedAt = Date.now()

    let summary: string
    try {
      summary = await this.summariseViaLlm(conversationText, session)
    } catch (err) {
      // The orchestrator catches this and falls back to summary-rewrite
      throw new AdapterError(
        `LLM summarisation failed: ${err instanceof Error ? err.message : String(err)}`,
        this.name,
        ErrorCode.AGENT_COMPACT_FAILED,
      )
    }

    const after = estimateTokens(summary)
    session.config.contextSummary = summary
    this.sessionOutputBuffers.set(sessionId, [])

    return {
      sessionId,
      strategy: 'llm',
      trigger: options?.reason ?? 'manual',
      tokensBefore: before,
      tokensAfter: after,
      summary,
      startedAt,
      durationMs: Date.now() - startedAt,
    }
  }

  /**
   * Summarise conversation text via the active session's LLM provider.
   * Returns a short text summary (no markdown, no preamble).
   */
  private async summariseViaLlm(text: string, session: AgentSession): Promise<string> {
    if (!text || text.trim().length === 0) {
      return '(no prior context)'
    }

    const summaryPrompt = `Summarise this agent conversation history concisely (max 1KB), preserving:
- Key decisions made
- Files modified or created
- Outstanding questions or blocked items
- Recent context the next turn needs

Conversation:
${text}

Output: a clean text summary. No preamble, no markdown.`

    const settings = await readSettings()
    const apiKey = resolveApiKey(settings.apiKeys, settings.defaultModel)
    if (!apiKey) {
      throw new AdapterError('No API key configured for LLM summarisation', this.name)
    }

    // Use compactModel if configured (cheaper model for summarisation),
    // otherwise fall back to defaultModel
    const compactModel = settings.compactModel || settings.defaultModel

    // Use a derived sessionId so the rate limiter covers compact sidecar calls
    // without counting against the active session's input budget.
    const compactSessionId = `${session.id}:compact`
    const result = await this.callLlmUnified(
      apiKey.provider,
      apiKey.key,
      apiKey.baseUrl,
      [
        { role: 'system', content: 'You are a precise conversation summariser.' },
        { role: 'user', content: summaryPrompt },
      ],
      compactModel,
      compactSessionId,
    )
    return result && result.length > 0 ? result : '(summary unavailable)'
  }
}