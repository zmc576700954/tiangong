import { describe, it, expect, vi } from 'vitest'
import { BaseAdapter } from '../base'
import type { AgentSession, AgentSessionConfig, AgentOutput } from '@shared/types'
import type { SubagentManager } from '../../agent/subagent-manager'

class TestAdapter extends BaseAdapter {
  readonly name = 'test'
  readonly version = '1.0.0'

  async checkInstalled(): Promise<boolean> {
    return true
  }

  async startSession(config: AgentSessionConfig): Promise<AgentSession> {
    return {
      id: 'test_session',
      adapterName: this.name,
      config,
      startTime: Date.now(),
    }
  }

  protected async doSendCommand(): Promise<void> {}
}

describe('BaseAdapter parseToolCalls', () => {
  it('parses a single dispatch_subagent call', () => {
    const adapter = new TestAdapter()
    const text = `Some reasoning\n<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "Find usages", "prompt": "Find Foo"}}</tool_call>\nMore text`
    const calls = adapter['parseToolCalls'](text)
    expect(calls).toHaveLength(1)
    expect(calls[0].tool).toBe('dispatch_subagent')
    expect(calls[0].args.agent_type).toBe('explore')
  })

  it('returns empty array when no tool_call tags present', () => {
    const adapter = new TestAdapter()
    expect(adapter['parseToolCalls']('no calls here')).toEqual([])
  })

  it('ignores malformed JSON inside tags', () => {
    const adapter = new TestAdapter()
    const text = '<tool_call>not json</tool_call>'
    expect(adapter['parseToolCalls'](text)).toEqual([])
  })
})

describe('BaseAdapter runToolAwareLoop', () => {
  it('emits stdout and completes when no tool calls', async () => {
    const adapter = new TestAdapter()
    adapter['subagentManager'] = { invoke: vi.fn() } as unknown as SubagentManager

    const outputs: AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter['runToolAwareLoop'](
      { id: 's1', adapterName: 'test', config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] }, startTime: Date.now() },
      { type: 'implement', description: 'Do it', targetNodeId: 'n1' },
      async () => 'plain result',
    )

    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'plain result')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete' && o.data === 'test session completed')).toBe(true)
  })

  it('invokes subagent and re-spawns with result', async () => {
    const adapter = new TestAdapter()
    const invoke = vi.fn().mockResolvedValue({ resultText: 'subagent done' })
    adapter['subagentManager'] = { invoke } as unknown as SubagentManager

    const outputs: AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    let secondCall = false
    await adapter['runToolAwareLoop'](
      { id: 's1', adapterName: 'test', config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] }, startTime: Date.now() },
      { type: 'implement', description: 'Do it', targetNodeId: 'n1' },
      async (prompt) => {
        if (secondCall) {
          expect(prompt).toContain('subagent done')
          return 'final result'
        }
        secondCall = true
        return '<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "x", "prompt": "y"}}</tool_call>'
      },
    )

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(outputs.some((o) => o.type === 'stdout' && o.data === 'final result')).toBe(true)
    expect(outputs.some((o) => o.type === 'complete' && o.data === 'test session completed')).toBe(true)
  })

  it('stops at max rounds', async () => {
    const adapter = new TestAdapter()
    const invoke = vi.fn().mockResolvedValue({ resultText: 'again' })
    adapter['subagentManager'] = { invoke } as unknown as SubagentManager

    const outputs: AgentOutput[] = []
    adapter.onOutput((o) => outputs.push(o))

    await adapter['runToolAwareLoop'](
      { id: 's1', adapterName: 'test', config: { workingDirectory: '/tmp', allowedFiles: [], forbiddenFiles: [], invariantRules: [], upstreamContext: '', downstreamContext: '', nodeTitle: '', acceptanceCriteria: [] }, startTime: Date.now() },
      { type: 'implement', description: 'Do it', targetNodeId: 'n1' },
      async () => '<tool_call>{"tool": "dispatch_subagent", "args": {"agent_type": "explore", "description": "x", "prompt": "y"}}</tool_call>',
    )

    expect(outputs.some((o) => o.type === 'error' && o.data.includes('max rounds'))).toBe(true)
  })
})
