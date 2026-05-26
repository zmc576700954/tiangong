/**
 * MCP / API Fallback Adapter
 *
 * When CLI agents (Claude Code, Codex, OpenCode) are not installed,
 * this adapter acts as a fallback using:
 * 1. Direct LLM API calls (Anthropic, OpenAI, DeepSeek)
 * 2. Optional MCP servers for enhanced tool use
 *
 * Reference: cc-switch unified configuration pattern
 */

import { randomUUID } from 'node:crypto'
import { BaseAdapter } from './base'
import { McpClient } from '../mcp/client'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'
import { readSettings } from '../settings'
import { AdapterError } from '../errors'

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
    const sessionId = `mcp-${randomUUID().replace(/-/g, '')}`

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
    const apiKey = settings.apiKeys[0]

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
    const systemPrompt = this.buildScopePrompt(session.config)

    // Gather MCP tool descriptions
    const clients = this.mcpClients.get(session.id) ?? []
    const toolDescriptions = clients
      .flatMap((c) => c.getTools())
      .map((t) => `- ${t.name}: ${t.description ?? 'No description'}`)
      .join('\n')

    const enhancedSystem = toolDescriptions
      ? `${systemPrompt}\n\n## Available MCP Tools\n${toolDescriptions}`
      : systemPrompt

    // Call LLM API
    try {
      const response = await this.callLlm(apiKey.provider, apiKey.key, apiKey.baseUrl, [
        { role: 'system', content: enhancedSystem },
        { role: 'user', content: userPrompt },
      ])

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

  private async callLlm(
    provider: string,
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
  ): Promise<string> {
    const settings = await readSettings()
    const defaultModel = settings.defaultModel
    switch (provider) {
      case 'anthropic':
        return this.callAnthropic(key, baseUrl, messages, defaultModel)
      case 'openai':
        return this.callOpenAi(key, baseUrl, messages, defaultModel)
      case 'deepseek':
        return this.callDeepSeek(key, baseUrl, messages, defaultModel)
      case 'gemini':
        return this.callGemini(key, baseUrl, messages, defaultModel)
      default:
        throw new AdapterError(`Unsupported provider: ${provider}`, this.name)
    }
  }

  private async callAnthropic(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
    defaultModel?: string,
  ): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
    const userMsgs = messages.filter((m) => m.role !== 'system')

    const url = baseUrl ? `${baseUrl}/v1/messages` : 'https://api.anthropic.com/v1/messages'
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: defaultModel ?? 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemMsg,
        messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new AdapterError(`Anthropic API error ${res.status}: ${text}`, this.name)
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] }
    return data.content?.find((c) => c.type === 'text')?.text ?? ''
  }

  private async callOpenAi(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
    defaultModel?: string,
  ): Promise<string> {
    const url = baseUrl ? `${baseUrl}/chat/completions` : 'https://api.openai.com/v1/chat/completions'
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: defaultModel ?? 'gpt-4o',
        messages,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new AdapterError(`OpenAI API error ${res.status}: ${text}`, this.name)
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  private async callDeepSeek(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
    defaultModel?: string,
  ): Promise<string> {
    const url = baseUrl ? `${baseUrl}/chat/completions` : 'https://api.deepseek.com/v1/chat/completions'
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: defaultModel ?? 'deepseek-chat',
        messages,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new AdapterError(`DeepSeek API error ${res.status}: ${text}`, this.name)
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  private async callGemini(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
    defaultModel?: string,
  ): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
    const userMsgs = messages.filter((m) => m.role !== 'system')
    const contents = userMsgs.map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }))

    const modelName = defaultModel ?? 'gemini-1.5-flash'
    const url = baseUrl
      ? `${baseUrl}/models/${modelName}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`

    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(baseUrl ? { 'x-goog-api-key': key } : {}),
      },
      body: JSON.stringify({
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        contents,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new AdapterError(`Gemini API error ${res.status}: ${text}`, this.name)
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  }
}
