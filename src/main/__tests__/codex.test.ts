import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand } from '@shared/types'

// Mock child_process before importing adapter
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
const mockSpawn = vi.fn(() => mockProc)

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>()
  return {
    ...actual,
    promisify: (fn: unknown) => fn,
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

describe('CodexAdapter', () => {
  let adapter: CodexAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new CodexAdapter()
  })

  it('should report name and version', () => {
    expect(adapter.name).toBe('codex')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when codex --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '0.1.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('codex', ['--version'])
  })

  it('checkInstalled returns false when codex not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)
    expect(session.adapterName).toBe('codex')
    expect(session.config).toBe(config)
    expect(session.id).toMatch(/^codex-/)
  })

  it('doSendCommand spawns codex with correct args', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)

    // Make runOneShot resolve immediately by simulating exit
    mockSpawn.mockImplementationOnce(() => {
      const proc = {
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
      }
      return proc
    })

    await adapter.sendCommand(session.id, command)

    expect(mockSpawn).toHaveBeenCalledWith(
      'codex',
      ['--approval-mode', 'full-auto', '-m', 'gpt-4o', '--', expect.any(String)],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('prompt includes scope, constraint suffix, and command', async () => {
    const config = makeConfig({
      nodeTitle: 'Auth Module',
      allowedFiles: ['src/auth.ts', 'src/login.ts'],
    })
    const session = await adapter.startSession(config)

    let capturedPrompt = ''
    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1]
      const proc = {
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
      return proc
    })

    await adapter.sendCommand(session.id, command)

    expect(capturedPrompt).toContain('业务节点：Auth Module')
    expect(capturedPrompt).toContain('⚠️ 强制约束')
    expect(capturedPrompt).toContain('src/auth.ts')
    expect(capturedPrompt).toContain('Add login form')
  })

  it('constraint suffix omitted when allowedFiles is empty', async () => {
    const config = makeConfig({ allowedFiles: [] })
    const session = await adapter.startSession(config)

    let capturedPrompt = ''
    mockSpawn.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1]
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

    expect(capturedPrompt).not.toContain('⚠️ 强制约束')
  })

  it('terminateSession closes the session', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    // Should not throw
    await adapter.terminateSession(session.id)
  })
})
