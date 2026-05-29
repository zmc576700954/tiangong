import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '../agentStore'

vi.stubGlobal('window', {
  electronAPI: {
    'agent:startSession': vi.fn().mockResolvedValue({ sessionId: 's1' }),
    'agent:sendCommand': vi.fn().mockResolvedValue(undefined),
    'agent:listAdapters': vi.fn().mockResolvedValue([]),
    'agent:terminateSession': vi.fn().mockResolvedValue(undefined),
    onAgentOutput: vi.fn(),
  },
})

describe('agentStore threads', () => {
  beforeEach(() => {
    useAgentStore.setState({
      threads: [],
      currentThreadId: null,
      sessions: [],
      currentSessionId: null,
      adapters: [],
    })
  })

  it('createThread adds a thread and sets it as current', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    const state = useAgentStore.getState()
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0].id).toBe(id)
    expect(state.threads[0].adapterName).toBe('claude-code')
    expect(state.threads[0].status).toBe('idle')
    expect(state.currentThreadId).toBe(id)
  })

  it('createThread with nodeBound sets the field', () => {
    useAgentStore.getState().createThread('claude-code', 'node_123')
    const thread = useAgentStore.getState().threads[0]
    expect(thread.nodeBound).toBe('node_123')
  })

  it('renameThread updates the title', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().renameThread(id, 'Login Feature')
    expect(useAgentStore.getState().threads[0].title).toBe('Login Feature')
  })

  it('deleteThread removes thread and selects next', () => {
    const id1 = useAgentStore.getState().createThread('claude-code')
    const id2 = useAgentStore.getState().createThread('codex')
    useAgentStore.getState().deleteThread(id1)
    const state = useAgentStore.getState()
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0].id).toBe(id2)
    expect(state.currentThreadId).toBe(id2)
  })

  it('deleteThread clears currentThreadId when no threads remain', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().deleteThread(id)
    expect(useAgentStore.getState().currentThreadId).toBeNull()
  })

  it('appendChatMessage adds message to the correct thread', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    })
    expect(useAgentStore.getState().threads[0].messages).toHaveLength(1)
    expect(useAgentStore.getState().threads[0].messages[0].content).toBe('Hello')
  })

  it('selectThread changes currentThreadId', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().selectThread(null)
    expect(useAgentStore.getState().currentThreadId).toBeNull()
    useAgentStore.getState().selectThread(id)
    expect(useAgentStore.getState().currentThreadId).toBe(id)
  })

  it('sendMessage adds user message and sets title from first message', async () => {
    const id = useAgentStore.getState().createThread('claude-code')
    await useAgentStore.getState().sendMessage(id, 'Implement login module')
    const thread = useAgentStore.getState().threads[0]
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0].role).toBe('user')
    expect(thread.messages[0].content).toBe('Implement login module')
    expect(thread.title).toBe('Implement login module')
    expect(thread.status).toBe('running')
  })

  it('sendMessage truncates title to 30 chars', async () => {
    const id = useAgentStore.getState().createThread('claude-code')
    const longMessage = 'A'.repeat(50)
    await useAgentStore.getState().sendMessage(id, longMessage)
    expect(useAgentStore.getState().threads[0].title).toHaveLength(30)
  })

  it('updateThreadStatus transitions thread status', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    expect(useAgentStore.getState().threads[0].status).toBe('idle')
    useAgentStore.getState().updateThreadStatus(id, 'running')
    expect(useAgentStore.getState().threads[0].status).toBe('running')
    useAgentStore.getState().updateThreadStatus(id, 'idle')
    expect(useAgentStore.getState().threads[0].status).toBe('idle')
  })

  it('updateThreadStatus to idle unblocks the input', async () => {
    const id = useAgentStore.getState().createThread('claude-code')
    await useAgentStore.getState().sendMessage(id, 'Hello')
    expect(useAgentStore.getState().threads[0].status).toBe('running')
    useAgentStore.getState().updateThreadStatus(id, 'idle')
    expect(useAgentStore.getState().threads[0].status).toBe('idle')
  })
})
