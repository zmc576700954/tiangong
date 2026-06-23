import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenCodeAdapter } from '../opencode'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { AgentSessionConfig, AgentOutput } from '@shared/types'
import type { SubagentManager } from '../../agent/subagent-manager'

vi.mock(import('node:child_process'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as Record<string, unknown>),
    spawn: vi.fn(),
  }
})

function createMockProc(stdoutChunks: string[], stderrChunks: string[] = []): ChildProcess {
  const stdinEmitter = new EventEmitter()
  const proc = new EventEmitter() as unknown as ChildProcess
  Object.assign(proc, {
    stdin: Object.assign(stdinEmitter, {
      write: vi.fn((_data, cb) => cb?.()),
      end: vi.fn(),
    }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    exitCode: null,
    pid: 1234,
  })

  setImmediate(() => {
    for (const chunk of stdoutChunks) (proc.stdout as EventEmitter).emit('data', Buffer.from(chunk))
    for (const chunk of stderrChunks) (proc.stderr as EventEmitter).emit('data', Buffer.from(chunk))
    proc.emit('exit', 0)
  })

  return proc
}

describe('OpenCodeAdapter inline subagent dispatch', () => {
  let adapter: OpenCodeAdapter

  beforeEach(() => {
    adapter = new OpenCodeAdapter()
    vi.mocked(spawn).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dispatches subagent when stdout contains tool_call', async () => {
    const invoke = vi.fn().mockResolvedValue({ resultText: 'exploration complete' })
    adapter.setSubagentManager({ invoke } as unknown as SubagentManager)

    const config: AgentSessionConfig = {
      workingDirectory: '/tmp',
      allowedFiles: ['src/foo.ts'],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test',
      acceptanceCriteria: [],
    }
    const session = await adapter.startSession(config)

    // First spawn emits tool call; second spawn returns final answer.
    let callCount = 0
    vi.mocked(spawn).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return createMockProc([
          '<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find Foo", "allowed_files": ["src/foo.ts"]}}</tool_call>',
        ])
      }
      return createMockProc(['final answer'])
    })

    const outputs: AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'Find usages', targetNodeId: 'n1' })

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: session.id,
      agentType: 'explore',
      prompt: 'Find Foo',
      allowedFiles: ['src/foo.ts'],
    }))
    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'final answer')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
  })

  it('completes normally when no tool_call present', async () => {
    adapter.setSubagentManager({ invoke: vi.fn() } as unknown as SubagentManager)

    const config: AgentSessionConfig = {
      workingDirectory: '/tmp',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: 'Test',
      acceptanceCriteria: [],
    }
    const session = await adapter.startSession(config)
    vi.mocked(spawn).mockImplementation(() => createMockProc(['plain output']))

    const outputs: AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter.sendCommand(session.id, { type: 'implement', description: 'Do it', targetNodeId: 'n1' })

    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'plain output')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete')).toBe(true)
  })
})
