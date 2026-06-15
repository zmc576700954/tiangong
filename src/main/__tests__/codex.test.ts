import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentSessionConfig, AgentCommand, AgentOutput } from '@shared/types'

// Mock Codex SDK
const mockRun = vi.fn().mockResolvedValue({
  items: [{ type: 'agent_message', id: 'msg-1', text: 'Task completed' }],
  finalResponse: 'All done',
  usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 },
})
const mockThreadId = 'thread-abc-123'
const mockThread = {
  run: mockRun,
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
    outputs.length = 0
    adapter = new CodexAdapter()
    adapter.onOutput((o) => outputs.push(o))
  })

  afterEach(() => {
    adapter.removeAllListeners('output')
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

    await adapter.sendCommand(session.id, command)

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/project', sandboxMode: 'workspace-write' }),
    )
    expect(mockRun).toHaveBeenCalledTimes(1)

    const promptArg = mockRun.mock.calls[0][0] as string
    expect(promptArg).toContain('<node-title>Auth Module</node-title>')
    expect(promptArg).toContain('src/auth.ts')
    expect(promptArg).toContain('Add login form')
  })

  it('doSendCommand emits agent messages as stdout', async () => {
    const config = makeConfig()
    const session = await adapter.startSession(config)

    await adapter.sendCommand(session.id, command)

    const stdoutOutputs = outputs.filter((o) => o.type === 'stdout')
    expect(stdoutOutputs.length).toBeGreaterThan(0)
    expect(stdoutOutputs.some((o) => o.data.includes('Task completed'))).toBe(true)
    expect(stdoutOutputs.some((o) => o.data.includes('All done'))).toBe(true)
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
})
