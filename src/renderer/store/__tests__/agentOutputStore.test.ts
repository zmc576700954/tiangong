import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAgentOutputStore } from '../agentOutputStore'
import type { AgentOutput } from '@shared/types'

function makeOutput(type: AgentOutput['type'], data: string): AgentOutput {
  return { type, data, timestamp: Date.now() }
}

describe('useAgentOutputStore', () => {
  beforeEach(() => {
    useAgentOutputStore.setState({ threadOutputs: {} })
  })

  it('getOutputs returns empty array for unknown thread', () => {
    expect(useAgentOutputStore.getState().getOutputs('t1')).toEqual([])
  })

  it('appendOutput buffers non-error outputs', async () => {
    vi.useFakeTimers()
    useAgentOutputStore.getState().appendOutput('t1', makeOutput('stdout', 'hello'))
    expect(useAgentOutputStore.getState().getOutputs('t1')).toEqual([])
    vi.advanceTimersByTime(20)
    await Promise.resolve()
    expect(useAgentOutputStore.getState().getOutputs('t1')).toHaveLength(1)
    vi.useRealTimers()
  })

  it('appendOutput immediately flushes error outputs', () => {
    useAgentOutputStore.getState().appendOutput('t1', makeOutput('error', 'crash'))
    expect(useAgentOutputStore.getState().getOutputs('t1')).toHaveLength(1)
  })

  it('clearThreadOutputs removes outputs and prevents buffered writes', async () => {
    vi.useFakeTimers()
    useAgentOutputStore.getState().appendOutput('t1', makeOutput('stdout', 'hello'))
    useAgentOutputStore.getState().clearThreadOutputs('t1')
    expect(useAgentOutputStore.getState().getOutputs('t1')).toEqual([])
    vi.advanceTimersByTime(20)
    await Promise.resolve()
    expect(useAgentOutputStore.getState().getOutputs('t1')).toEqual([])
    vi.useRealTimers()
  })

  it('removeThreadOutputs deletes thread outputs', () => {
    useAgentOutputStore.getState().appendOutput('t1', makeOutput('error', 'crash'))
    useAgentOutputStore.getState().removeThreadOutputs('t1')
    expect(useAgentOutputStore.getState().getOutputs('t1')).toEqual([])
  })

  it('trimInactiveThreadOutputs trims non-active threads', () => {
    const outputs: AgentOutput[] = Array.from({ length: 150 }, (_, i) => makeOutput('stdout', `line-${i}`))
    useAgentOutputStore.setState({ threadOutputs: { t1: outputs, t2: outputs } })
    useAgentOutputStore.getState().trimInactiveThreadOutputs('t1')
    expect(useAgentOutputStore.getState().getOutputs('t1')).toHaveLength(150)
    expect(useAgentOutputStore.getState().getOutputs('t2')).toHaveLength(100)
  })
})
