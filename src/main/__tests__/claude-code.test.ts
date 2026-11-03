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
const mockReadSettings = vi.fn().mockResolvedValue({ defaultModel: 'sonnet', apiKeys: [] })

vi.mock('../settings', () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
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
    mockReadSettings.mockResolvedValue({ defaultModel: 'sonnet', apiKeys: [] })
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

  it('同一会话连发两条命令：system 段逐字节一致，前一条命令原文不进后一条的 system 段', async () => {
    const session = await adapter.startSession(makeConfig())
    adapter.setPromptContext(session.id, { stable: 'STABLE-TEXT', turn: 'TURN-ONE' })

    mockQuery.mockImplementation(() => mockMessages([
      { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' },
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'COMMAND-ONE', targetNodeId: 'n1' })

    // 第二轮：编排器重装配后 stable 跨轮不变，turn 随请求变化
    adapter.setPromptContext(session.id, { stable: 'STABLE-TEXT', turn: 'TURN-TWO' })
    await adapter.sendCommand(session.id, { type: 'implement', description: 'COMMAND-TWO', targetNodeId: 'n1' })

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const first = mockQuery.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> }
    const second = mockQuery.mock.calls[1][0] as { prompt: string; options: Record<string, unknown> }

    // system 段跨轮逐字节一致 —— 可复用 KV-cache 前缀
    expect(second.options.systemPrompt).toBe(first.options.systemPrompt)
    // 前一条命令原文不得出现在后一条的 system 段
    expect(String(second.options.systemPrompt)).not.toContain('COMMAND-ONE')
    // 每条命令原文只在自己的 user turn 里出现一次
    expect(first.prompt.split('COMMAND-ONE').length - 1).toBe(1)
    expect(second.prompt.split('COMMAND-TWO').length - 1).toBe(1)
    expect(second.prompt).not.toContain('COMMAND-ONE')
    expect(second.prompt).toContain('TURN-TWO')
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

  it('透明转发会话拿不到任何内置工具（A2A 入站的边界）', async () => {
    // A2A 入站会话也是空的 allowedFiles → 会被推导成只读。若只读分支排在
    // transparent 之前，远端调用方就多拿到了本机 Read/Glob/Grep 与 **WebFetch
    // （出网）** —— 违反 CLAUDE.md Boundaries §3 的透明转发边界。
    const session = await adapter.startSession(
      makeConfig({ transparentForward: true, readOnly: true }),
    )
    adapter.setPromptContext(session.id, { stable: '', turn: '' })

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'X', targetNodeId: 'n1' })

    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    // tools: [] = 禁用全部内置工具
    expect(callArgs.options.tools).toEqual([])
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

  it('result 的 is_error=true 即使 subtype=success 也按失败处理', async () => {
    const session = await adapter.startSession(makeConfig())
    const ended: Array<[string, string, number | null]> = []
    adapter.on('sessionEnded', (id: string, reason: string, code: number | null) => {
      ended.push([id, reason, code])
    })

    // SDK 的 success 结果也可能带 is_error=true —— 只看 subtype 会把失败当成功投给渲染层。
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'tool failed', is_error: true, errors: ['tool failed'] },
    ]))

    await adapter.sendCommand(session.id, command)

    expect(outputs.filter((o) => o.type === 'complete')).toHaveLength(0)
    expect(outputs.filter((o) => o.type === 'error')).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(ended[0][1]).toBe('error')
  })

  it('result 的错误 subtype 也发 sessionEnded(error) —— 恢复 / 回退链路要可达', async () => {
    const session = await adapter.startSession(makeConfig())
    const ended: Array<[string, string, number | null]> = []
    adapter.on('sessionEnded', (id: string, reason: string, code: number | null) => {
      ended.push([id, reason, code])
    })

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] },
    ]))

    await adapter.sendCommand(session.id, command)

    expect(outputs.filter((o) => o.type === 'error')).toHaveLength(1)
    expect(ended).toHaveLength(1)
    expect(ended[0][1]).toBe('error')
  })

  it('result 错误消息缺 errors 数组时不抛异常，退化为兜底文案', async () => {
    const session = await adapter.startSession(makeConfig())

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'error_during_execution', is_error: true },
    ]))

    await adapter.sendCommand(session.id, command)

    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs).toHaveLength(1)
    expect(errorOutputs[0].data).toContain('Agent execution failed')
  })

  it('SDK 错误时发射 sessionEnded(error)，AbortError 时不发射', async () => {
    const session = await adapter.startSession(makeConfig())
    const ended: Array<[string, string, number | null]> = []
    adapter.on('sessionEnded', (id: string, reason: string, code: number | null) => {
      ended.push([id, reason, code])
    })

    mockQuery.mockReturnValue((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-sess-1' }
      throw new Error('boom')
    })())

    await adapter.sendCommand(session.id, command)

    expect(ended).toHaveLength(1)
    expect(ended[0][1]).toBe('error')

    const session2 = await adapter.startSession(makeConfig())
    mockQuery.mockReturnValue((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-sess-2' }
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    })())

    await adapter.sendCommand(session2.id, command)

    // AbortError = 用户主动取消，不是会话异常终止 —— 不发 sessionEnded
    expect(ended).toHaveLength(1)
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

  it('doSendCommand 用 claudeCode 档位的模型（不读其它适配器的档位）', async () => {
    mockReadSettings.mockResolvedValue({
      defaultModel: 'legacy-model',
      apiKeys: [],
      defaultModels: { claudeCode: 'opus-4-1', codex: 'gpt-5' },
    })
    const session = await adapter.startSession(makeConfig())

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    expect(callArgs.options.model).toBe('opus-4-1')
  })

  it('doSendCommand 在 claudeCode 档位为空时回落到旧的 defaultModel', async () => {
    mockReadSettings.mockResolvedValue({
      defaultModel: 'legacy-model',
      apiKeys: [],
      defaultModels: { codex: 'gpt-5' },
    })
    const session = await adapter.startSession(makeConfig())

    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))

    await adapter.sendCommand(session.id, command)

    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    expect(callArgs.options.model).toBe('legacy-model')
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

/**
 * 只读会话：Agent **物理上**拿不到写工具。
 *
 * 只读不能靠 ScopeGuard 的空白名单沙箱实现 —— 那条路的 watcher 监听整棵项目树，
 * 分不清「Agent 写的」和「用户写的」，在真实项目目录上会把用户自己改的文件
 * 判为越界并回滚删除。所以只读做在适配器层：SDK 的 `tools` 白名单。
 */
describe('ClaudeCodeAdapter — 只读会话', () => {
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSettings.mockResolvedValue({ defaultModel: 'sonnet', apiKeys: [] })
    adapter = new ClaudeCodeAdapter()
  })

  afterEach(() => {
    adapter.removeAllListeners('output')
  })

  async function sendWith(config: AgentSessionConfig): Promise<Record<string, unknown>> {
    const session = await adapter.startSession(config)
    adapter.setPromptContext(session.id, { stable: 'S', turn: '' })
    mockQuery.mockReturnValue(mockMessages([
      { type: 'result', subtype: 'success', result: 'Done', is_error: false },
    ]))
    await adapter.sendCommand(session.id, command)
    const callArgs = mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }
    return callArgs.options
  }

  it('只读会话的 tools 白名单里没有任何写工具或命令执行', async () => {
    const options = await sendWith(makeConfig({ readOnly: true }))

    const tools = options.tools as string[]
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
    // 关键断言：白名单里**不能**出现能改文件或跑命令的工具
    for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput']) {
      expect(tools).not.toContain(forbidden)
    }
    // 但读与查必须在 —— 否则 Agent 连代码都看不了
    expect(tools).toContain('Read')
  })

  it('只读会话隔离外部 MCP 配置与文件级 settings（否则外部 MCP / hook 能写盘）', async () => {
    const options = await sendWith(makeConfig({ readOnly: true }))

    // strictMcpConfig：只用 mcpServers 选项里显式传入的 server，
    // 忽略项目 .mcp.json / 用户设置 / 插件里的 MCP
    expect(options.strictMcpConfig).toBe(true)
    // settingSources: [] —— 不加载 user/project/local 的 settings.json（无 hook）
    expect(options.settingSources).toEqual([])
  })

  it('非只读会话不改变 MCP 与 settings 的加载方式', async () => {
    const options = await sendWith(makeConfig())
    // 可写会话保持既有行为 —— 不能因为加了只读分支就收紧普通会话
    expect(options.strictMcpConfig).toBeUndefined()
    expect(options.settingSources).toBeUndefined()
  })

  it('只读会话的 permissionMode 是 default（不是 acceptEdits）', async () => {
    const options = await sendWith(makeConfig({ readOnly: true }))
    expect(options.permissionMode).toBe('default')
  })

  it('非只读会话不受影响：tools 不设、permissionMode 仍是 acceptEdits', async () => {
    const options = await sendWith(makeConfig())
    expect(options.tools).toBeUndefined()
    expect(options.permissionMode).toBe('acceptEdits')
  })

  it('只读会话同时是子代理时，tools 取白名单与子代理 allowedTools 的交集', async () => {
    // 子代理被允许 Edit —— 若不取交集，父会话的只读保证就被破坏了
    const options = await sendWith(makeConfig({
      readOnly: true,
      subagentAllowedTools: ['Read', 'Edit', 'Bash'],
    }))

    const tools = options.tools as string[]
    expect(tools).toContain('Read')
    expect(tools).not.toContain('Edit')
    expect(tools).not.toContain('Bash')
  })
})
