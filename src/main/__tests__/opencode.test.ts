import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'
import type { SubagentManager } from '../agent/subagent-manager'

const mockExecFile = vi.fn()
const mockProc = {
  stdout: { on: vi.fn(), off: vi.fn() },
  stderr: { on: vi.fn(), off: vi.fn() },
  stdin: { write: vi.fn() },
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
  kill: vi.fn(),
  killed: false,
}
const mockSpawn = vi.fn((_cmd: string, _args: readonly string[], _options: object) => mockProc)

vi.mock('node:child_process', () => ({
  spawn: (...args: [string, readonly string[], object]) => mockSpawn(...args),
  execFile: (...args: [string, readonly string[]]) => mockExecFile(...args),
}))

vi.mock('node:util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    promisify: (fn: unknown) => fn,
  }
})

import { OpenCodeAdapter } from '../adapters/opencode'

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

const command: AgentCommand = { type: 'fix_bug', description: 'Fix crash on save', targetNodeId: 'n1' }

describe('OpenCodeAdapter', () => {
  let adapter: OpenCodeAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new OpenCodeAdapter()
    adapter.setSubagentManager({ invoke: vi.fn() } as unknown as SubagentManager)
  })

  it('should report name and version', () => {
    expect(adapter.name).toBe('opencode')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when opencode --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '0.2.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('opencode', ['--version'], expect.objectContaining({ timeout: expect.any(Number) }))
  })

  it('checkInstalled returns false when opencode not found', async () => {
    mockExecFile.mockRejectedValue(new Error('command not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    expect(session.adapterName).toBe('opencode')
    expect(session.config).toEqual(config)
    expect(session.id).toMatch(/^opencode-/)
  })

  it('doSendCommand spawns opencode with correct args', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)

    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('done'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    // 1.0 的 `-q` 在 1.19 上会被当未知参数、打帮助页并 exit 0 —— 宿主于是把
    // 帮助文本当模型输出。契约改为 `run --format json`，prompt 走位置参数。
    expect(mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['run', '--format', 'json', expect.stringContaining('Fix crash on save')],
      expect.objectContaining({ cwd: '/my/project', stdio: ['ignore', 'pipe', 'pipe'] }),
    )
  })

  it('prompt includes scope, constraint suffix, and command', async () => {
    const config = makeConfig({
      nodeTitle: 'Storage Module',
      allowedFiles: ['src/storage.ts'],
      forbiddenFiles: ['src/legacy.ts'],
    })
    const session = await adapter.startSession(config)
    // Task 3 起适配器消费编排器投递的 promptContext，不再自行构造 scope。
    adapter.setPromptContext(session.id, {
      stable: '# 业务节点：Storage Module\n## 禁止修改的文件（黑名单）\n- src/legacy.ts',
      turn: 'TURN-CTX',
    })

    let capturedPrompt = ''
    mockSpawn.mockImplementationOnce((_cmd: string, args: readonly string[]) => {
      capturedPrompt = args[args.length - 1] ?? ''
      return {
        ...mockProc,
        stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === 'data') cb(Buffer.from('ok'))
        }), off: vi.fn() },
        stderr: { on: vi.fn(), off: vi.fn() },
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === 'exit') cb(0)
        }),
        once: vi.fn(),
        off: vi.fn(),
      }
    })

    await adapter.sendCommand(session.id, command)

    expect(capturedPrompt).toContain('Storage Module')
    expect(capturedPrompt).toContain('⚠️ 强制约束')
    expect(capturedPrompt).toContain('src/storage.ts')
    expect(capturedPrompt).toContain('禁止修改的文件（黑名单）')
    expect(capturedPrompt).toContain('TURN-CTX')
    expect(capturedPrompt).toContain('Fix crash on save')
  })

  it('constraint suffix omitted when allowedFiles is empty', async () => {
    const config = makeConfig({ allowedFiles: [] })
    const session = await adapter.startSession(config)

    let capturedPrompt = ''
    mockSpawn.mockImplementationOnce((_cmd: string, args: readonly string[]) => {
      capturedPrompt = args[args.length - 1] ?? ''
      return {
        ...mockProc,
        stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === 'data') cb(Buffer.from('ok'))
        }), off: vi.fn() },
        stderr: { on: vi.fn(), off: vi.fn() },
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === 'exit') cb(0)
        }),
        once: vi.fn(),
        off: vi.fn(),
      }
    })

    await adapter.sendCommand(session.id, command)

    expect(capturedPrompt).not.toContain('⚠️ 强制约束')
  })

  it('terminateSession closes the session', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    await adapter.terminateSession(session.id)
  })

  it('把 JSONL 事件逐条投到 rawEvent（kind=json），供 Driver 结构化归一化', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"hello"}}',
    ].join('\n')

    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(stdout))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    const raw: Array<{ kind?: string; event?: { type?: string } }> = []
    adapter.onRawEvent((event) => raw.push(event.payload as { kind?: string }))

    await adapter.sendCommand(session.id, command)

    const jsonEvents = raw.filter((payload) => payload.kind === 'json')
    expect(jsonEvents.map((payload) => payload.event?.type)).toEqual(['step_start', 'text'])
    // 文本旁路仍然保留（排障 / 旧路径），但结构化消费方只认 kind:'json'
    expect(raw.some((payload) => payload.kind === 'stdout')).toBe(true)
  })

  it('参数被拒打出帮助页时报错，不把帮助文本当模型输出', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    const helpPage = [
      'Commands:',
      '  opencode run [message..]     run opencode with a message',
      '  opencode [project]           start opencode tui',
    ].join('\n')

    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from(helpPage))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0) // 注意：CLI 这里是 exit 0
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    const outputs: AgentOutput[] = []
    adapter.onOutput((output) => outputs.push(output))

    await adapter.sendCommand(session.id, command)

    expect(outputs.some((output) => output.type === 'error')).toBe(true)
  })
})
