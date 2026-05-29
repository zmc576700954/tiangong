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

import { BaseAdapter } from './base'
import { McpClient } from '../mcp/client'
import { generateId } from '../shared/env'
import type { AgentSession, AgentSessionConfig, AgentCommand, ApiKeyConfig } from '@shared/types'
import { readSettings } from '../settings'
import { AdapterError } from '../errors'

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// ============================================
// Provider 配置（抽象 LLM 调用差异）
// ============================================

interface ProviderConfig {
  defaultModel: string
  buildUrl: (baseUrl: string | undefined, key: string, model: string) => string
  buildHeaders: (key: string, baseUrl: string | undefined) => Record<string, string>
  buildBody: (messages: LlmMessage[], model: string) => unknown
  extractContent: (data: unknown) => string
}

const PROVIDER_CONFIGS: Record<string, ProviderConfig> = {
  anthropic: {
    defaultModel: 'claude-3-5-sonnet-20241022',
    buildUrl: (baseUrl) => baseUrl ? `${baseUrl}/v1/messages` : 'https://api.anthropic.com/v1/messages',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    buildBody: (messages, model) => {
      const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
      const userMsgs = messages.filter((m) => m.role !== 'system')
      return {
        model,
        max_tokens: 4096,
        system: systemMsg,
        messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
      }
    },
    extractContent: (data: unknown) => {
      const d = data as { content?: { type: string; text?: string }[] }
      return d.content?.find((c) => c.type === 'text')?.text ?? ''
    },
  },
  openai: {
    defaultModel: 'gpt-4o',
    buildUrl: (baseUrl) => baseUrl ? `${baseUrl}/chat/completions` : 'https://api.openai.com/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (messages, model) => ({ model, messages }),
    extractContent: (data: unknown) => {
      const d = data as { choices?: { message?: { content?: string } }[] }
      return d.choices?.[0]?.message?.content ?? ''
    },
  },
  deepseek: {
    defaultModel: 'deepseek-chat',
    buildUrl: (baseUrl) => baseUrl ? `${baseUrl}/chat/completions` : 'https://api.deepseek.com/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    }),
    buildBody: (messages, model) => ({ model, messages }),
    extractContent: (data: unknown) => {
      const d = data as { choices?: { message?: { content?: string } }[] }
      return d.choices?.[0]?.message?.content ?? ''
    },
  },
  gemini: {
    defaultModel: 'gemini-1.5-flash',
    buildUrl: (baseUrl, key, model) => baseUrl
      ? `${baseUrl}/models/${model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    buildHeaders: (key, baseUrl) => ({
      'Content-Type': 'application/json',
      ...(baseUrl ? { 'x-goog-api-key': key } : {}),
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
    extractContent: (data: unknown) => {
      const d = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      return d.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
    },
  },
}

export class McpAdapter extends BaseAdapter {
  readonly name = 'mcp'
  readonly version = '1.0.0'

  private mcpClients = new Map<string, McpClient[]>()

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

    for (const server of enabledServers) {
      try {
        const client = new McpClient(server.command, server.args)
        await client.connect()
        sessionClients.push(client)
        this.emitOutput({
          type: 'stdout',
          data: `MCP server connected: ${server.name}`,
          timestamp: Date.now(),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.emitOutput({
          type: 'stderr',
          data: `MCP server failed (${server.name}): ${msg}`,
          timestamp: Date.now(),
        })
      }
    }

    this.mcpClients.set(sessionId, sessionClients)

    // Build scope prompt
    const scopePrompt = this.buildScopePrompt(config)

    const session: AgentSession = {
      id: sessionId,
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }

    this.registerSession(session)

    this.emitOutput({
      type: 'stdout',
      data: `MCP fallback session started.\n${scopePrompt}`,
      timestamp: Date.now(),
    })

    return session
  }

  protected async doSendCommand(session: AgentSession, command: AgentCommand, _proc?: unknown): Promise<void> {
    const settings = await readSettings()

    // W4-FIX: 根据 session config 或 settings.defaultModel 匹配 provider 的 API Key
    const apiKey = this.resolveApiKey(settings.apiKeys, settings.defaultModel)

    if (!apiKey) {
      this.emitOutput({
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
    const systemPrompt = this.buildScopePrompt(session.config, session.resolvedContexts)

    // Gather MCP tool descriptions
    const clients = this.mcpClients.get(session.id) ?? []
    const toolDescriptions = clients
      .flatMap((c) => c.getTools())
      .map((t) => `- ${t.name}: ${t.description ?? 'No description'}`)
      .join('\n')

    const enhancedSystem = toolDescriptions
      ? `${systemPrompt}\n\n## Available MCP Tools\n${toolDescriptions}`
      : systemPrompt

    // Call LLM API via unified provider config
    try {
      const response = await this.callLlmUnified(
        apiKey.provider,
        apiKey.key,
        apiKey.baseUrl,
        [
          { role: 'system', content: enhancedSystem },
          { role: 'user', content: userPrompt },
        ],
        settings.defaultModel,
      )

      this.emitOutput({
        type: 'stdout',
        data: response,
        timestamp: Date.now(),
      })

      this.emitOutput({
        type: 'complete',
        data: 'MCP session completed',
        timestamp: Date.now(),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emitOutput({
        type: 'error',
        data: `LLM API error: ${msg}`,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * 根据 provider 匹配 API Key，而非盲目取第一个
   * 如果 settings.defaultModel 包含 provider 名称线索，优先匹配对应的 Key
   */
  private resolveApiKey(apiKeys: ApiKeyConfig[], defaultModel?: string): ApiKeyConfig | undefined {
    // 优先级1：根据 defaultModel 名称推断 provider
    if (defaultModel) {
      if (defaultModel.includes('claude') || defaultModel.includes('sonnet') || defaultModel.includes('opus')) {
        const found = apiKeys.find((k) => k.provider === 'anthropic')
        if (found) return found
      }
      if (defaultModel.includes('gpt') || defaultModel.includes('o1') || defaultModel.includes('o3') || defaultModel.includes('o4')) {
        const found = apiKeys.find((k) => k.provider === 'openai')
        if (found) return found
      }
      if (defaultModel.includes('deepseek')) {
        const found = apiKeys.find((k) => k.provider === 'deepseek')
        if (found) return found
      }
      if (defaultModel.includes('gemini')) {
        const found = apiKeys.find((k) => k.provider === 'gemini')
        if (found) return found
      }
    }

    // 优先级2：返回第一个有对应 provider config 的 Key
    return apiKeys.find((k) => PROVIDER_CONFIGS[k.provider] !== undefined)
  }

  protected async doTerminate(session: AgentSession, _proc?: unknown): Promise<void> {
    // Disconnect MCP clients for this session only
    const clients = this.mcpClients.get(session.id) ?? []
    for (const client of clients) {
      try {
        await client.disconnect()
      } catch (err) {
        console.warn(`[McpAdapter] Failed to disconnect MCP client:`, err)
      }
    }
    this.mcpClients.delete(session.id)

    this.emitOutput({
      type: 'complete',
      data: 'MCP session terminated',
      timestamp: Date.now(),
    })
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
   * 统一的 LLM API 调用：根据 ProviderConfig 自动适配
   */
  private async callLlmUnified(
    provider: string,
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
    defaultModel?: string,
  ): Promise<string> {
    const config = PROVIDER_CONFIGS[provider]
    if (!config) {
      throw new AdapterError(`Unsupported provider: ${provider}`, this.name)
    }

    const model = defaultModel ?? config.defaultModel
    const url = config.buildUrl(baseUrl, key, model)
    const headers = config.buildHeaders(key, baseUrl)
    const body = config.buildBody(messages, model)

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new AdapterError(`${provider} API error ${res.status}: ${text}`, this.name)
    }

    const data = await res.json()
    return config.extractContent(data)
  }
}