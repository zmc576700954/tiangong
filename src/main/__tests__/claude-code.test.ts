import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'

// Mock the SDK module before importing adapter
const mockQuery = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  // Phase 4: claude-code.ts pulls createSdkMcpServer from the SDK for
  // the dispatch_subagent tool registration. Tests don't exercise it
  // (no SubagentManager is injected) but vitest's strict mock guard
  // requires the export to be defined.
  createSdkMcpServer: vi.fn(),
}))

// Mock settings to provide defaultModel
vi.mock('../settings', () => ({
  readSettings: vi.fn().mockResolvedValue({ defaultModel: 'sonnet', apiKeys: [] }),
}))

import { ClaudeCodeAdapter } from '../adapters/claude-code'

function makeConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return {
    workingDirectory: '/project',
    nodeTitle: 'Test Node',
    acceptanceCriteria: [],
    allowedFiles: [],
    forbiddenFiles: [],
    invariantRules: [],
    upstreamContext: '',
    downstreamContext: '',
    ...overrides,
  }
}

const command: AgentCommand = { type: 'implement', description: 'Add login form', targetNodeId: 'n1' }

async function* mockMessages(messages: unknown[]) {
  for (const msg of messages) {
    yield msg
  }
}

describe('ClaudeCodeAdapter (SDK)', () => {
  let adapter: ClaudeCodeAdapter
  const outputs: AgentOutput[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    outputs.length = 0
    adapter = new ClaudeCodeAdapter()
    adapter.onOutput((o) => outputs.push(o))
  })

  afterEach(() => {
    adapter.removeAllListeners('output')
  })

  it('should report name and version', () => {
    expect(adapter.name).toBe('claude-code')
    expect(adapter.version).toBe('2.0.0')
  })

  it('checkInstalled returns true when SDK is available', async () => {
    mockQuery.mockReturnValue(mockMessages([]))
    expect(await adapter.checkInstalled()).toBe(true)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    expect(session.adapterName).toBe('claude-code')
    expect(session.config).toEqual(config)
    expect(session.id).toMatch(/^claude-/)
  })

  it('doSendCommand 把 promptContext.stable 作为 systemPrompt 下发', async () => {
    const session = await adapter.startSession(makeConfig())
    // Task 3 起适配器不再自行构造 scope，而是消费编排器投递的 promptContext。
    adapter.setPromptContext(session.id, {
      stable: '# 业务节点：<node-title>Auth Module</node-title>\n## 允许修改的文件（白名单）\n- src/auth.ts\n<criteria>Users can login</criteria>',
      turn: '',
    })

    mockQuery.mockReturnValue(mockMessages([
      { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    expect(mockQuery).toHaveBeenCalledTimes(1)
    const callArgs = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
    expect(callArgs.prompt).toContain('Add login form')
    expect(callArgs.options.systemPrompt).toContain('<node-title>Auth Module</node-title>')
    expect(callArgs.options.systemPrompt).toContain('src/auth.ts')
    expect(callArgs.options.systemPrompt).toContain('<criteria>Users can login</criteria>')
    expect(callArgs.options.cwd).toBe('/project')

    const completeOutputs = outputs.filter((o) => o.type === 'complete')
    expect(completeOutputs.length).toBe(1)
  })

  it('systemPrompt 只含 stable，user turn 含 turn + 命令原文，命令原文只出现一次', async () => {
    const session = await adapter.startSession(makeConfig())
    adapter.setPromptContext(session.id, { stable: 'STABLE-TEXT', turn: 'TURN-TEXT' })

    mockQuery.mockReturnValue(mockMessages([
      { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'USER-REQ-UNIQUE', targetNodeId: 'n1' })

    const callArgs = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
    expect(callArgs.options.systemPrompt).toBe('STABLE-TEXT')
    expect(String(callArgs.options.systemPrompt)).not.toContain('USER-REQ-UNIQUE')
    expect(callArgs.prompt).toContain('TURN-TEXT')
    expect(callArgs.prompt).toContain('USER-REQ-UNIQUE')
    expect(callArgs.prompt.split('USER-REQ-UNIQUE').length - 1).toBe(1)
  })

  it('透明转发会话不下发任何 BizGraph 上下文', async () => {
    const session = await adapter.startSession(makeConfig({ transparentForward: true }))
    adapter.setPromptContext(session.id, { stable: 'STABLE-TEXT', turn: 'TURN-TEXT' })

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'USER-REQ-UNIQUE', targetNodeId: 'n1' })

    const callArgs = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
    expect(callArgs.options.systemPrompt).toBeUndefined()
    expect(callArgs.prompt).not.toContain('STABLE-TEXT')
    expect(callArgs.prompt).not.toContain('TURN-TEXT')
    expect(callArgs.prompt).toContain('USER-REQ-UNIQUE')
  })

  it('doSendCommand captures SDK session ID for resume', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    mockQuery.mockReturnValue(mockMessages([
      { type: 'system', subtype: 'init', session_id: 'sdk-sess-42' },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    expect(session.config.resumeSessionId).toBe('sdk-sess-42')
  })

  it('doSendCommand passes resume option when resumeSessionId is set', async () => {
    const config = makeConfig({ resumeSessionId: 'existing-session' })
    const session = await adapter.startSession(config)

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    expect(callArgs.options.resume).toBe('existing-session')
  })

  it('doSendCommand emits assistant text as stdout', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    mockQuery.mockReturnValue(mockMessages([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will edit the file now.' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    const stdoutOutputs = outputs.filter((o) => o.type === 'stdout')
    expect(stdoutOutputs.some((o) => o.data.includes('I will edit the file now.'))).toBe(true)
  })

  it('doSendCommand emits error on SDK failure', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution', result: 'Rate limit exceeded', is_error: true, errors: ['Rate limit exceeded'] },
    ]))

    await adapter.sendCommand(session.id, command)

    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs.length).toBe(1)
    expect(errorOutputs[0].data).toContain('Rate limit')
  })

  it('doSendCommand sets permissionMode to acceptEdits', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    expect(callArgs.options.permissionMode).toBe('acceptEdits')
  })

  it('doSendCommand configures PostToolUse hook for file tracking', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    const hooks = callArgs.options.hooks as Record<string, unknown[]>
    expect(hooks.PostToolUse).toBeDefined()
    expect(hooks.PostToolUse.length).toBe(1)
    expect((hooks.PostToolUse[0] as { matcher: string }).matcher).toBe('Edit|Write')
  })

  it('terminateSession aborts active query', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    // Simulate a long-running query
    mockQuery.mockReturnValue(mockMessages([
      { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' },
    ]))

    const sendPromise = adapter.sendCommand(session.id, command)
    await adapter.terminateSession(session.id)
    await sendPromise.catch(() => {})
  })
})
