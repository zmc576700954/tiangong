import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand } from '@shared/types'

const mockExecFile = vi.fn()
const mockProc = {
  stdout: { on: vi.fn(), off: vi.fn() },
  stderr: { on: vi.fn(), off: vi.fn() },
  stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), writableEnded: false },
  on: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
  kill: vi.fn(),
  killed: false,
}
const mockSpawn = vi.fn((_cmd: string, _args: readonly string[], _options: object) => ({
  ...mockProc,
  stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn(), writableEnded: false },
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

vi.mock('node:child_process', () => ({
  spawn: (...args: [string, readonly string[], object]) => mockSpawn(...args),
  execFile: (...args: [string, readonly string[]]) => mockExecFile(...args),
}))

vi.mock('node:util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, promisify: (fn: unknown) => fn }
})

import { ClineAdapter } from '../cline'
import { CodeBuddyAdapter } from '../codebuddy'
import { KiloCodeAdapter } from '../kilo-code'
import { KimiCodeAdapter } from '../kimi-code'
import { QoderAdapter } from '../qoder'
import { QwenCodeAdapter } from '../qwen-code'

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

const command: AgentCommand = { type: 'implement', description: 'Add feature', targetNodeId: 'n1' }

// ─── ClineAdapter ───
describe('ClineAdapter', () => {
  let adapter: ClineAdapter

  beforeEach(() => { vi.clearAllMocks(); adapter = new ClineAdapter() })

  it('should report name and version', () => {
    expect(adapter.name).toBe('cline')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when cline --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('cline', ['--version'])
  })

  it('checkInstalled returns false when cline not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('cline')
    expect(session.id).toMatch(/^cline-/)
  })

  it('doSendCommand spawns cline with stdin prompt', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    expect(mockSpawn).toHaveBeenCalledWith(
      'cline',
      [],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('terminateSession closes the session', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.terminateSession(session.id)
  })
})

// ─── CodeBuddyAdapter ───
describe('CodeBuddyAdapter', () => {
  let adapter: CodeBuddyAdapter

  beforeEach(() => { vi.clearAllMocks(); adapter = new CodeBuddyAdapter() })

  it('should report name and version', () => {
    expect(adapter.name).toBe('codebuddy')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when codebuddy --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('codebuddy', ['--version'])
  })

  it('checkInstalled tries alternate cbc command', async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error('not found'))
      .mockResolvedValueOnce({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('cbc', ['--version'])
  })

  it('checkInstalled returns false when neither codebuddy nor cbc found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('codebuddy')
    expect(session.id).toMatch(/^cbuddy-/)
  })

  it('doSendCommand spawns codebuddy with prompt as arg', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    expect(mockSpawn).toHaveBeenCalledWith(
      'codebuddy',
      expect.arrayContaining([expect.stringContaining('Add feature')]),
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('terminateSession closes the session', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.terminateSession(session.id)
  })
})

// ─── KiloCodeAdapter ───
describe('KiloCodeAdapter', () => {
  let adapter: KiloCodeAdapter

  beforeEach(() => { vi.clearAllMocks(); adapter = new KiloCodeAdapter() })

  it('should report name and version', () => {
    expect(adapter.name).toBe('kilo-code')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when kilo --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('kilo', ['--version'])
  })

  it('checkInstalled returns false when kilo not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('kilo-code')
    expect(session.id).toMatch(/^kilo-/)
  })

  it('doSendCommand spawns kilo run --auto with stdin prompt', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    expect(mockSpawn).toHaveBeenCalledWith(
      'kilo',
      ['run', '--auto'],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('terminateSession closes the session', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.terminateSession(session.id)
  })
})

// ─── KimiCodeAdapter ───
describe('KimiCodeAdapter', () => {
  let adapter: KimiCodeAdapter

  beforeEach(() => { vi.clearAllMocks(); adapter = new KimiCodeAdapter() })

  it('should report name and version', () => {
    expect(adapter.name).toBe('kimi-code')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when kimi --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('kimi', ['--version'])
  })

  it('checkInstalled returns false when kimi not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('kimi-code')
    expect(session.id).toMatch(/^kimi-/)
  })

  it('doSendCommand spawns kimi -p with stdin prompt', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    expect(mockSpawn).toHaveBeenCalledWith(
      'kimi',
      ['-p'],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('terminateSession closes the session', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.terminateSession(session.id)
  })
})

// ─── QoderAdapter ───
describe('QoderAdapter', () => {
  let adapter: QoderAdapter

  beforeEach(() => { vi.clearAllMocks(); adapter = new QoderAdapter() })

  it('should report name and version', () => {
    expect(adapter.name).toBe('qoder')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when qodercli --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('qodercli', ['--version'])
  })

  it('checkInstalled returns false when qodercli not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('qoder')
    expect(session.id).toMatch(/^qoder-/)
  })

  it('doSendCommand spawns qodercli with prompt as arg', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    expect(mockSpawn).toHaveBeenCalledWith(
      'qodercli',
      expect.arrayContaining([expect.stringContaining('Add feature')]),
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('terminateSession closes the session', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.terminateSession(session.id)
  })
})

// ─── QwenCodeAdapter ───
describe('QwenCodeAdapter', () => {
  let adapter: QwenCodeAdapter

  beforeEach(() => { vi.clearAllMocks(); adapter = new QwenCodeAdapter() })

  it('should report name and version', () => {
    expect(adapter.name).toBe('qwen-code')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when qwen --version succeeds', async () => {
    mockExecFile.mockResolvedValue({ stdout: '1.0.0\n', stderr: '' })
    expect(await adapter.checkInstalled()).toBe(true)
    expect(mockExecFile).toHaveBeenCalledWith('qwen', ['--version'])
  })

  it('checkInstalled returns false when qwen not found', async () => {
    mockExecFile.mockRejectedValue(new Error('not found'))
    expect(await adapter.checkInstalled()).toBe(false)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('qwen-code')
    expect(session.id).toMatch(/^qwen-/)
  })

  it('doSendCommand spawns qwen -p with prompt as arg', async () => {
    const config = makeConfig({ workingDirectory: '/my/project' })
    const session = await adapter.startSession(config)
    await adapter.sendCommand(session.id, command)
    expect(mockSpawn).toHaveBeenCalledWith(
      'qwen',
      ['-p', expect.stringContaining('Add feature')],
      expect.objectContaining({ cwd: '/my/project' }),
    )
  })

  it('terminateSession closes the session', async () => {
    const session = await adapter.startSession(makeConfig())
    await adapter.terminateSession(session.id)
  })
})
