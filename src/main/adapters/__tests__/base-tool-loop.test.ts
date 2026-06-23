import { describe, it, expect, vi } from 'vitest'
import { BaseAdapter } from '../base'
import type { AgentSession, AgentSessionConfig, AgentCommand } from '@shared/types'

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
