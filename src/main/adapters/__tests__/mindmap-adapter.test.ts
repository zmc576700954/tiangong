import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'

const mockRunClaude = vi.fn()

vi.mock('../../mindmap-agent/claude-runner', () => ({
  runClaude: (...args: unknown[]) => mockRunClaude(...args),
}))

vi.mock('../../platform', () => ({
  getPlatformProvider: () => ({
    getShellConfig: () => ({ shell: true }),
  }),
}))

import { MindMapAdapter } from '../mindmap-adapter'

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

const command: AgentCommand = { type: 'implement', description: 'Generate mind map', targetNodeId: 'n1' }

describe('MindMapAdapter', () => {
  let adapter: MindMapAdapter
  const outputs: AgentOutput[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    outputs.length = 0
    adapter = new MindMapAdapter()
    adapter.onOutput((o) => outputs.push(o))
  })

  it('should report name and version', () => {
    expect(adapter.name).toBe('mindmap-internal')
    expect(adapter.version).toBe('1.0.0')
  })

  it('checkInstalled returns true when claude CLI is available', async () => {
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
    }))
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockReturnValue('1.0.0')
    expect(await adapter.checkInstalled()).toBe(true)
  })

  it('startSession creates a session with correct adapter name', async () => {
    const session = await adapter.startSession(makeConfig())
    expect(session.adapterName).toBe('mindmap-internal')
    expect(session.id).toMatch(/^mindmap-/)
  })

  it('doSendCommand calls runClaude and emits stdout on success', async () => {
    mockRunClaude.mockResolvedValue({
      stdout: '{"modules":[]}',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    })

    const session = await adapter.startSession(makeConfig())
    await adapter.sendCommand(session.id, command)

    expect(mockRunClaude).toHaveBeenCalledWith(
      expect.stringContaining('Generate mind map'),
      expect.objectContaining({ cwd: '/project', timeoutMs: 300_000, outputFormat: 'text' }),
    )

    const stdoutOutputs = outputs.filter((o) => o.type === 'stdout')
    expect(stdoutOutputs.some((o) => o.data.includes('{"modules":[]}'))).toBe(true)

    const completeOutputs = outputs.filter((o) => o.type === 'complete')
    expect(completeOutputs.length).toBe(1)
  })

  it('doSendCommand emits error on timeout', async () => {
    mockRunClaude.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: true,
    })

    const session = await adapter.startSession(makeConfig())
    await adapter.sendCommand(session.id, command)

    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs.length).toBe(1)
    expect(errorOutputs[0].errorCode).toBe('TIMEOUT')
  })

  it('doSendCommand emits error on non-zero exit code', async () => {
    mockRunClaude.mockResolvedValue({
      stdout: '',
      stderr: 'permission denied',
      exitCode: 1,
      timedOut: false,
    })

    const session = await adapter.startSession(makeConfig())
    await adapter.sendCommand(session.id, command)

    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs.length).toBe(1)
    expect(errorOutputs[0].data).toContain('permission denied')
    expect(errorOutputs[0].errorCode).toBe('AGENT_CRASH')
  })

  it('doSendCommand emits error on exception', async () => {
    mockRunClaude.mockRejectedValue(new Error('spawn failed'))

    const session = await adapter.startSession(makeConfig())
    await adapter.sendCommand(session.id, command)

    const errorOutputs = outputs.filter((o) => o.type === 'error')
    expect(errorOutputs.length).toBe(1)
    expect(errorOutputs[0].data).toContain('spawn failed')
  })

  it('terminateSession aborts active controller', async () => {
    let resolveRun: (v: unknown) => void
    mockRunClaude.mockImplementation(() => new Promise((resolve) => { resolveRun = resolve }))

    const session = await adapter.startSession(makeConfig())
    const cmdPromise = adapter.sendCommand(session.id, command)

    await adapter.terminateSession(session.id)

    resolveRun!({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
    await cmdPromise
  })
})
