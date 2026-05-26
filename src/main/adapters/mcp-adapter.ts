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

import { BaseAdapter } from './base'
import { McpClient } from '../mcp/client'
import type { AgentSession, AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'
import { readSettings } from '../settings'

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class McpAdapter extends BaseAdapter {
  readonly name = 'mcp'
  readonly version = '1.0.0'

  private mcpClients: McpClient[] = []

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
    const sessionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    // Connect to enabled MCP servers
    const settings = await readSettings()
    const enabledServers = settings.mcpServers.filter((s) => s.enabled)

    for (const server of enabledServers) {
      try {
        const client = new McpClient(server.command, server.args)
        await client.connect()
        this.mcpClients.push(client)
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

    // Build scope prompt
    const scopePrompt = this.buildScopePrompt(config)

    // Start a "fake" process for interface compatibility
    const proc = { stdin: null, stdout: null, stderr: null, killed: false, kill: () => {}, on: () => {} } as unknown as AgentSession['process']

    const session: AgentSession = {
      id: sessionId,
      process: proc,
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

  protected async doSendCommand(session: AgentSession, command: AgentCommand): Promise<void> {
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
    const toolDescriptions = this.mcpClients
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

  protected async doTerminate(session: AgentSession): Promise<void> {
    // Disconnect MCP clients
    for (const client of this.mcpClients) {
      try {
        await client.disconnect()
      } catch {}
    }
    this.mcpClients = []

    this.emitOutput({
      type: 'complete',
      data: 'MCP session terminated',
      timestamp: Date.now(),
    })
  }

  private async callLlm(
    provider: string,
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
  ): Promise<string> {
    switch (provider) {
      case 'anthropic':
        return this.callAnthropic(key, baseUrl, messages)
      case 'openai':
        return this.callOpenAi(key, baseUrl, messages)
      case 'deepseek':
        return this.callDeepSeek(key, baseUrl, messages)
      default:
        throw new Error(`Unsupported provider: ${provider}`)
    }
  }

  private async callAnthropic(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
  ): Promise<string> {
    const systemMsg = messages.find((m) => m.role === 'system')?.content ?? ''
    const userMsgs = messages.filter((m) => m.role !== 'system')

    const url = baseUrl ? `${baseUrl}/v1/messages` : 'https://api.anthropic.com/v1/messages'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        system: systemMsg,
        messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] }
    return data.content?.find((c) => c.type === 'text')?.text ?? ''
  }

  private async callOpenAi(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
  ): Promise<string> {
    const url = baseUrl ? `${baseUrl}/chat/completions` : 'https://api.openai.com/v1/chat/completions'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }

  private async callDeepSeek(
    key: string,
    baseUrl: string | undefined,
    messages: LlmMessage[],
  ): Promise<string> {
    const url = baseUrl ? `${baseUrl}/chat/completions` : 'https://api.deepseek.com/v1/chat/completions'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`DeepSeek API error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? ''
  }
}
