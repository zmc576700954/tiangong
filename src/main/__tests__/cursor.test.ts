import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand } from '@shared/types'

const mockExecFile = vi.fn()
const mockProc = {
  stdout: { on: vi.fn(), off: vi.fn() },
  stderr: { on: vi.fn(), off: vi.fn() },
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
  const actual = await importOriginal<typeof import('node:util')>()
  return { ...actual, promisify: (fn: unknown) => fn }
})

import { CursorAdapter } from '../adapters/cursor'

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

describe('CursorAdapter', () => {
  let adapter: CursorAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new CursorAdapter()
  })

  it('should report name and version', () => {
    expect(adapter.name).toBe('cursor')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when cursor agent --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('cursor', ['agent', '--version'])
  })

  it('checkInstalled returns false when cursor not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    expect(session.adapterName).toBe('cursor')
    expect(session.id).toMatch(/^cursor-/)
  })

  it('doSendCommand spawns cursor agent with -p flag', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)

    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('done'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      once: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    expect(mockSpawn).toHaveBeenCalledWith(
      'cursor',
      ['agent', '-p', expect.stringContaining('Add login form')],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('doSendCommand includes --resume when resumeSessionId is set', async () => {
    const config = makeConfig({ resumeSessionId: 'prev-session' })
    const session = await adapter.startSession(config)

    mockSpawn.mockImplementationOnce(() => ({
      ...mockProc,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('ok'))
      }), off: vi.fn() },
      stderr: { on: vi.fn(), off: vi.fn() },
      on: vi.fn(),
      once: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'exit') cb(0)
      }),
      off: vi.fn(),
    }))

    await adapter.sendCommand(session.id, command)

    expect(mockSpawn).toHaveBeenCalledWith(
      'cursor',
      expect.arrayContaining(['--resume', 'prev-session']),
      expect.anything(),
    )
  })

  it('doSendCommand includes scope prompt in command', async () => {
    const config = makeConfig({
      nodeTitle: 'Payment Module',
      acceptanceCriteria: ['Handle refunds'],
    })
    const session = await adapter.startSession(config)

    let capturedPrompt = ''
    mockSpawn.mockImplementationOnce((_cmd: string, args: readonly string[]) => {
      capturedPrompt = args[2] // args are ['agent', '-p', prompt, ...]
      return {
        ...mockProc,
        stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
          if (event === 'data') cb(Buffer.from('ok'))
        }), off: vi.fn() },
        stderr: { on: vi.fn(), off: vi.fn() },
        on: vi.fn(),
        once: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === 'exit') cb(0)
        }),
        off: vi.fn(),
      }
    })

    await adapter.sendCommand(session.id, command)

    expect(capturedPrompt).toContain('业务节点：Payment Module')
    expect(capturedPrompt).toContain('Handle refunds')
    expect(capturedPrompt).toContain('Add login form')
  })

  it('terminateSession closes the session', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    await adapter.terminateSession(session.id)
  })
})
