import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'

// Mock Codex SDK
const mockRun = vi.fn().mockResolvedValue({
  items: [{ type: 'agent_message', id: 'msg-1', text: 'Task completed' }],
  finalResponse: 'All done',
  usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 },
})
/**
 * P1-B / D-08 双路径：
 * - 默认走流式 `thread.runStreamed()`；
 * - 显式 `BIZGRAPH_CODEX_STREAMING=0` 时回退阻塞 `thread.run()`，保留 finalResponse 语义。
 * mock 用 run() 的结果拼出流式事件。
 */
const mockRunStreamed = vi.fn(async (prompt: string) => ({
  events: (async function* () {
    yield { type: 'thread.started' }
    yield { type: 'turn.started' }
    const result = await mockRun(prompt)
    for (const item of result.items as Array<Record<string, unknown>>) {
      yield { type: 'item.completed', item }
    }
    yield { type: 'turn.completed', usage: result.usage }
  })(),
}))
const mockThreadId = 'thread-abc-123'
const mockThread = {
  run: mockRun,
  runStreamed: mockRunStreamed,
  get id() { return mockThreadId },
}
const mockStartThread = vi.fn(() => mockThread)
const mockResumeThread = vi.fn(() => mockThread)

class MockCodex {
  startThread = mockStartThread
  resumeThread = mockResumeThread
}

vi.mock('@openai/codex-sdk', () => ({
  Codex: MockCodex,
}))

// codex 适配器读取自己的默认模型档位（settings.defaultModels.codex）。
const mockReadSettings = vi.fn()

vi.mock('../settings', () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
}))

/**
 * G7-2 路由：装了审批钩子就不该碰 SDK。
 *
 * 真实 app-server 要 spawn 一个 CLI（CI 上没有），所以这里只替换
 * `CodexAppServerClient.start`，协议胶水由 `codex-app-server.test.ts` 覆盖。
 * 假客户端把「回合已完成」直接推给订阅者，方便断言路径与收尾。
 */
const mockAppServerStart = vi.fn()
const mockAppServerReply = vi.fn()
const mockAppServerDispose = vi.fn(async () => {})
/** 每次 start 的订阅者，用来在 startTurn 后推事件 */
let appServerListeners: Array<(event: unknown) => void> = []

function makeFakeAppServerClient() {
  return {
    // pid 留空：跳过进程登记（那是真实进程才有的语义）
    pid: undefined,
    startThread: vi.fn(async () => ({ threadId: 'th-app-server' })),
    resumeThread: vi.fn(async () => ({ threadId: 'th-app-server-resumed' })),
    startTurn: vi.fn(async () => {
      for (const listener of appServerListeners) {
        listener({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'app-server 跑完了' } })
        listener({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } })
      }
      return { turnId: 'tu-1' }
    }),
    onEvent: (listener: (event: unknown) => void) => {
      appServerListeners.push(listener)
      return () => {
        appServerListeners = appServerListeners.filter((item) => item !== listener)
      }
    },
    replyApproval: mockAppServerReply,
    dispose: mockAppServerDispose,
  }
}

vi.mock('../adapters/codex-app-server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    CodexAppServerClient: {
      start: (...args: unknown[]) => mockAppServerStart(...args),
    },
  }
})

import { CodexAdapter } from '../adapters/codex'

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

describe('CodexAdapter (SDK)', () => {
  let adapter: CodexAdapter
  const outputs: AgentOutput[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadSettings.mockResolvedValue({
      defaultModel: 'claude-3-7-sonnet-20250219',
      apiKeys: [],
      defaultModels: {},
    })
    outputs.length = 0
    delete process.env.BIZGRAPH_CODEX_STREAMING
    adapter = new CodexAdapter()
    adapter.onOutput((o) => outputs.push(o))
  })

  afterEach(() => {
    adapter.removeAllListeners('output')
    delete process.env.BIZGRAPH_CODEX_STREAMING
  })

  it('should report name and version', () => {
    expect(adapter.name).toBe('codex')
    expect(adapter.version).toBe('2.0.0')
  })

  it('checkInstalled returns true when SDK is available', async () => {
    expect(await adapter.checkInstalled()).toBe(true)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    expect(session.adapterName).toBe('codex')
    expect(session.id).toMatch(/^codex-/)
  })

  it('doSendCommand creates Codex instance and calls startThread', async () => {
    const config = makeConfig({
      nodeTitle: 'Auth Module',
      allowedFiles: ['src/auth.ts'],
    })
    const session = await adapter.startSession(config)
    // Task 3 起适配器消费编排器投递的 promptContext，不再自行构造 scope。
    adapter.setPromptContext(session.id, {
      stable: '# 业务节点：<node-title>Auth Module</node-title>\n- src/auth.ts',
      turn: 'TURN-CTX',
    })

    await adapter.sendCommand(session.id, command)

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/project', sandboxMode: 'workspace-write' }),
    )
    // D-08：默认流式
    expect(mockRunStreamed).toHaveBeenCalledTimes(1)

    const promptArg = mockRunStreamed.mock.calls[0][0] as string
    expect(promptArg).toContain('<node-title>Auth Module</node-title>')
    expect(promptArg).toContain('src/auth.ts')
    expect(promptArg).toContain('TURN-CTX')
    expect(promptArg).toContain('Add login form')
  })

  it('doSendCommand emits agent messages as stdout', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    const stdoutOutputs = outputs.filter((o) => o.type === 'stdout')
    expect(stdoutOutputs.length).toBeGreaterThan(0)
    // D-08 默认流式：item.completed 的 agent_message 只广播一次；finalResponse 不再重复广播
    expect(stdoutOutputs.filter((o) => o.data.includes('Task completed'))).toHaveLength(1)
    expect(stdoutOutputs.some((o) => o.data === 'All done')).toBe(false)
  })

  it('defaults to runStreamed (D-08)', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    const raw: unknown[] = []
    adapter.onRawEvent((event) => raw.push(event))

    await adapter.sendCommand(session.id, command)

    expect(mockRunStreamed).toHaveBeenCalledTimes(1)
    expect(raw.length).toBeGreaterThan(0)
  })

  it('falls back to blocking run() when BIZGRAPH_CODEX_STREAMING=0', async () => {
    process.env.BIZGRAPH_CODEX_STREAMING = '0'
    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    expect(mockRun).toHaveBeenCalledTimes(1)
    expect(mockRunStreamed).not.toHaveBeenCalled()
    // 阻塞路径保留 finalResponse 广播
    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'All done')).toBe(true)
  })

  it('doSendCommand emits complete on success', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    const completeOutputs = outputs.filter((o) => o.type === 'complete')
    expect(completeOutputs.length).toBe(1)
  })

  it('doSendCommand captures thread ID for resume', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    expect(session.config.resumeSessionId).toBe('thread-abc-123')
  })

  it('doSendCommand emits file_change for file_change items', async () => {
    mockRun.mockResolvedValueOnce({
      items: [{
        type: 'file_change',
        id: 'fc-1',
        changes: [
          { path: 'src/auth.ts', kind: 'update' },
          { path: 'src/new.ts', kind: 'add' },
        ],
        status: 'completed',
      }],
      finalResponse: 'Files changed',
      usage: null,
    })

    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    const fileChangeOutputs = outputs.filter((o) => o.type === 'file_change')
    expect(fileChangeOutputs.length).toBe(2)
    expect(fileChangeOutputs[0].filePath).toBe('src/auth.ts')
    expect(fileChangeOutputs[0].changeType).toBe('modify')
    expect(fileChangeOutputs[1].filePath).toBe('src/new.ts')
    expect(fileChangeOutputs[1].changeType).toBe('add')
  })

  it('doSendCommand uses resumeThread when resumeSessionId is set', async () => {
    const config = makeConfig({ resumeSessionId: 'thread-existing' })
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    expect(mockResumeThread).toHaveBeenCalledWith('thread-existing', expect.anything())
    expect(mockStartThread).not.toHaveBeenCalled()
  })

  it('doSendCommand 把 codex 档位的模型传给 startThread', async () => {
    mockReadSettings.mockResolvedValue({
      defaultModel: 'claude-3-7-sonnet-20250219',
      apiKeys: [],
      defaultModels: { codex: 'gpt-5' },
    })
    const session = await adapter.startSession(makeConfig())

    await adapter.sendCommand(session.id, command)

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5' }),
    )
  })

  it('doSendCommand 把 codex 档位的模型传给 resumeThread', async () => {
    mockReadSettings.mockResolvedValue({
      defaultModel: 'claude-3-7-sonnet-20250219',
      apiKeys: [],
      defaultModels: { codex: 'gpt-5' },
    })
    const session = await adapter.startSession(makeConfig({ resumeSessionId: 'thread-existing' }))

    await adapter.sendCommand(session.id, command)

    expect(mockResumeThread).toHaveBeenCalledWith(
      'thread-existing',
      expect.objectContaining({ model: 'gpt-5' }),
    )
  })

  it('只读会话 → sandboxMode 传 read-only（startThread 与 resumeThread 两条路）', async () => {
    const session = await adapter.startSession(makeConfig({ readOnly: true }))
    await adapter.sendCommand(session.id, command)
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: 'read-only' }),
    )

    vi.clearAllMocks()
    mockReadSettings.mockResolvedValue({ defaultModel: 'sonnet', apiKeys: [] })
    const resumeSession = await adapter.startSession(
      makeConfig({ readOnly: true, resumeSessionId: 'thread-existing' }),
    )
    await adapter.sendCommand(resumeSession.id, command)
    expect(mockResumeThread).toHaveBeenCalledWith(
      'thread-existing',
      expect.objectContaining({ sandboxMode: 'read-only' }),
    )
  })

  it('非只读会话仍是 workspace-write', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.sendCommand(session.id, command)
    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: 'workspace-write' }),
    )
  })

  it('codex 档位为空时不传模型（由 SDK 自己决定），且不回落到旧的 defaultModel', async () => {
    const session = await adapter.startSession(makeConfig())

    await adapter.sendCommand(session.id, command)

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined }),
    )
  })

  it('doSendCommand emits error on SDK failure', async () => {
    mockRun.mockRejectedValueOnce(new Error('API rate limit'))

    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs.length).toBe(1)
    expect(errorOutputs[0].data).toContain('rate limit')
  })

  it('reuses thread for same session (multi-turn)', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)
    await adapter.sendCommand(session.id, { ...command, description: 'Now add tests' })

    expect(mockStartThread).toHaveBeenCalledTimes(1)
    expect(mockRun).toHaveBeenCalledTimes(2)
  })

  it('terminateSession cleans up thread', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    await adapter.terminateSession(session.id)
  })

  it('装了审批钩子就改走 app-server，不再碰 SDK', async () => {
    appServerListeners = []
    mockAppServerStart.mockResolvedValue(makeFakeAppServerClient())

    const config = makeConfig()
    const session = await adapter.startSession(config)
    adapter.setTurnApprovalHooks(session.id, {
      canUseTool: vi.fn(async () => ({ behavior: 'allow' as const })),
    })

    await adapter.sendCommand(session.id, command)

    expect(mockAppServerStart).toHaveBeenCalledTimes(1)
    expect(mockStartThread).not.toHaveBeenCalled()
    expect(mockRunStreamed).not.toHaveBeenCalled()

    // 线程参数：on-request 是「问了再放行」的开关
    const client = (await mockAppServerStart.mock.results[0].value) as ReturnType<typeof makeFakeAppServerClient>
    expect(client.startThread).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/project', approvalPolicy: 'on-request', sandbox: 'workspace-write' }),
    )
    // 事件照 SDK 方言发出去，归一化器零改动
    expect(outputs.some((o) => o.type === 'stdout' && o.data.includes('app-server 跑完了'))).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
    expect(mockAppServerDispose).toHaveBeenCalled()
  })

  it('有可信的 resumeSessionId 时用 thread/resume 续接，而不是新开线程', async () => {
    appServerListeners = []
    mockAppServerStart.mockResolvedValue(makeFakeAppServerClient())

    const config = makeConfig()
    const session = await adapter.startSession(config)
    // 形如 UUIDv7 的原生 id 才允许续接
    session.config.resumeSessionId = '01a1d30b-28a7-79c0-bd83-1007b218befb'
    adapter.setTurnApprovalHooks(session.id, {
      canUseTool: vi.fn(async () => ({ behavior: 'allow' as const })),
    })

    await adapter.sendCommand(session.id, command)

    const client = (await mockAppServerStart.mock.results[0].value) as ReturnType<typeof makeFakeAppServerClient>
    expect(client.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: '01a1d30b-28a7-79c0-bd83-1007b218befb' }),
    )
    expect(client.startThread).not.toHaveBeenCalled()
  })

  it('卸掉钩子后回到 SDK 的 exec 路径', async () => {
    appServerListeners = []
    mockAppServerStart.mockResolvedValue(makeFakeAppServerClient())

    const config = makeConfig()
    const session = await adapter.startSession(config)
    adapter.setTurnApprovalHooks(session.id, {
      canUseTool: vi.fn(async () => ({ behavior: 'allow' as const })),
    })
    adapter.setTurnApprovalHooks(session.id, null)

    await adapter.sendCommand(session.id, command)

    expect(mockAppServerStart).not.toHaveBeenCalled()
    expect(mockRunStreamed).toHaveBeenCalledTimes(1)
  })

  it('app-server 起不来时直接失败，绝不退回没人看的 exec 路径', async () => {
    appServerListeners = []
    mockAppServerStart.mockRejectedValue(
      new Error('failed to load configuration: unknown variant `max`'),
    )

    const config = makeConfig()
    const session = await adapter.startSession(config)
    adapter.setTurnApprovalHooks(session.id, {
      canUseTool: vi.fn(async () => ({ behavior: 'allow' as const })),
    })

    await adapter.sendCommand(session.id, command)

    expect(mockRunStreamed).not.toHaveBeenCalled()
    expect(mockStartThread).not.toHaveBeenCalled()
    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs.length).toBe(1)
    expect(errorOutputs[0].data).toContain('unknown variant `max`')
  })
})
