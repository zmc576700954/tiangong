import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand } from '@shared/types'
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
    expect(mockExecFile).toHaveBeenCalledWith('opencode', ['--version'])
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

    expect(mockSpawn).toHaveBeenCalledWith(
      'opencode',
      ['-q'],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('prompt includes scope, constraint suffix, and command', async () => {
    const config = makeConfig({
      nodeTitle: 'Storage Module',
      allowedFiles: ['src/storage.ts'],
      forbiddenFiles: ['src/legacy.ts'],
    })
    const session = await adapter.startSession(config)

    let capturedPrompt = ''
    const mockStdin = {
      write: vi.fn((data: string, _cb?: (err?: Error) => void) => { capturedPrompt = data }),
      end: vi.fn(),
      on: vi.fn(),
    }
    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdin: mockStdin,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('ok'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    expect(capturedPrompt).toContain('Storage Module')
    expect(capturedPrompt).toContain('⚠️ 强制约束')
    expect(capturedPrompt).toContain('src/storage.ts')
    expect(capturedPrompt).toContain('禁止修改的文件（黑名单）')
    expect(capturedPrompt).toContain('Fix crash on save')
  })

  it('constraint suffix omitted when allowedFiles is empty', async () => {
    const config = makeConfig({ allowedFiles: [] })
    const session = await adapter.startSession(config)

    let capturedPrompt = ''
    const mockStdin = {
      write: vi.fn((data: string, _cb?: (err?: Error) => void) => { capturedPrompt = data }),
      end: vi.fn(),
      on: vi.fn(),
    }
    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdin: mockStdin,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('ok'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    expect(capturedPrompt).not.toContain('⚠️ 强制约束')
  })

  it('terminateSession closes the session', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    await adapter.terminateSession(session.id)
  })

  it('attaches stdin error handler before writing', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    const mockStdin = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
    }
    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdin: mockStdin,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('ok'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    const errorHandlerCall = mockStdin.on.mock.calls.find((call: unknown[]) => call[0] === 'error')
    expect(errorHandlerCall).toBeDefined()
    expect(mockStdin.write).toHaveBeenCalled()
    expect(mockStdin.end).toHaveBeenCalled()
  })

  it('does not write to stdin when it has already ended', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    const mockStdin = {
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: true,
    }
    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdin: mockStdin,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('ok'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      once: vi.fn(),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    expect(mockStdin.on).not.toHaveBeenCalled()
    expect(mockStdin.write).not.toHaveBeenCalled()
    expect(mockStdin.end).not.toHaveBeenCalled()
  })
})
