import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSubagentStore } from '../subagentStore'
import type { SubagentInvocation, AgentOutput } from '@shared/types'

vi.stubGlobal('window', {
  electronAPI: {
    'subagent:listInvocations': vi.fn().mockResolvedValue([]),
    'subagent:listTypes': vi.fn().mockResolvedValue([]),
    'subagent:cancel': vi.fn().mockResolvedValue(undefined),
    'subagent:getResult': vi.fn().mockResolvedValue(null),
  },
})

describe('useSubagentStore', () => {
  beforeEach(() => {
    useSubagentStore.setState({ invocations: [], outputsByInvocation: new Map(), subagentTypes: [] })
  })

  it('loadInvocations fetches and sets invocations', async () => {
    const invocations: SubagentInvocation[] = [{
      id: 'i1',
      parentSessionId: 's1',
      parentMessageId: null,
      graphId: null,
      agentType: 'coder',
      description: 'desc',
      prompt: 'hello',
      adapterName: null,
      nodeId: 'n1',
      allowedFiles: null,
      status: 'running',
      resultText: null,
      resultFiles: null,
      tokensUsed: 0,
      startedAt: 1,
      finishedAt: null,
      error: null,
    }]
    vi.mocked(window.electronAPI['subagent:listInvocations']).mockResolvedValueOnce(invocations)
    await useSubagentStore.getState().loadInvocations('s1')
    expect(useSubagentStore.getState().invocations).toEqual(invocations)
  })

  it('loadTypes fetches and sets types', async () => {
    const types = [{ name: 'coder', displayName: 'Coder', description: 'Coder', allowedTools: [], scopeStrategy: 'inherit' as const }]
    vi.mocked(window.electronAPI['subagent:listTypes']).mockResolvedValueOnce(types)
    await useSubagentStore.getState().loadTypes()
    expect(useSubagentStore.getState().subagentTypes).toEqual(types)
  })

  it('appendOutput buffers outputs per invocation', () => {
    const output: AgentOutput = { type: 'stdout', data: 'hello', timestamp: 1 }
    useSubagentStore.getState().appendOutput('i1', output)
    expect(useSubagentStore.getState().outputsByInvocation.get('i1')).toEqual([output])
  })

  it('appendOutput caps output buffer', () => {
    for (let i = 0; i < 505; i++) {
      useSubagentStore.getState().appendOutput('i1', { type: 'stdout', data: `${i}`, timestamp: i })
    }
    expect(useSubagentStore.getState().outputsByInvocation.get('i1')?.length).toBe(500)
  })

  it('applyProgress updates invocation status', () => {
    useSubagentStore.setState({
      invocations: [{
        id: 'i1',
        parentSessionId: 's1',
        parentMessageId: null,
        graphId: null,
        agentType: 'coder',
        description: 'desc',
        prompt: 'hello',
        adapterName: null,
        nodeId: 'n1',
        allowedFiles: null,
        status: 'running',
        resultText: null,
        resultFiles: null,
        tokensUsed: 0,
        startedAt: 1,
        finishedAt: null,
        error: null,
      }],
    })
    useSubagentStore.getState().applyProgress({ invocationId: 'i1', status: 'completed' })
    expect(useSubagentStore.getState().invocations[0].status).toBe('completed')
  })

  it('applyProgress ignores invalid status', () => {
    useSubagentStore.setState({
      invocations: [{
        id: 'i1',
        parentSessionId: 's1',
        parentMessageId: null,
        graphId: null,
        agentType: 'coder',
        description: 'desc',
        prompt: 'hello',
        adapterName: null,
        nodeId: 'n1',
        allowedFiles: null,
        status: 'running',
        resultText: null,
        resultFiles: null,
        tokensUsed: 0,
        startedAt: 1,
        finishedAt: null,
        error: null,
      }],
    })
    useSubagentStore.getState().applyProgress({ invocationId: 'i1', status: 'invalid-status' })
    expect(useSubagentStore.getState().invocations[0].status).toBe('running')
  })

  it('cancelInvocation calls IPC', async () => {
    await useSubagentStore.getState().cancelInvocation('i1')
    expect(window.electronAPI['subagent:cancel']).toHaveBeenCalledWith('i1')
  })

  it('getResult returns result from IPC', async () => {
    const result = { invocationId: 'i1', resultText: 'done', resultFiles: [], tokensUsed: 0, durationMs: 0 }
    vi.mocked(window.electronAPI['subagent:getResult']).mockResolvedValueOnce(result)
    const got = await useSubagentStore.getState().getResult('i1')
    expect(got).toEqual(result)
  })

  it('reset clears state', () => {
    useSubagentStore.setState({
      invocations: [{ id: 'i1', parentSessionId: 's1', parentMessageId: null, graphId: null, agentType: 'coder', description: 'desc', prompt: 'hello', adapterName: null, nodeId: 'n1', allowedFiles: null, status: 'running', resultText: null, resultFiles: null, tokensUsed: 0, startedAt: 1, finishedAt: null, error: null }],
      outputsByInvocation: new Map([['i1', []]]),
      subagentTypes: [{ name: 'coder', displayName: 'Coder', description: '', allowedTools: [], scopeStrategy: 'inherit' as const }],
    })
    useSubagentStore.getState().reset()
    expect(useSubagentStore.getState().invocations).toEqual([])
    expect(useSubagentStore.getState().outputsByInvocation.size).toBe(0)
    expect(useSubagentStore.getState().subagentTypes).toEqual([])
  })
})
