import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useThreadStore } from '../threadStore'

let threadCounter = 0
vi.stubGlobal('window', {
  electronAPI: {
    'thread:create': vi.fn().mockImplementation(() => {
      threadCounter++
      return Promise.resolve({ id: `thread-${threadCounter}`, title: 'New Thread', adapterName: 'claude-code', messages: [], contextRefs: [], status: 'idle', createdAt: Date.now() })
    }),
    'thread:update': vi.fn().mockResolvedValue(undefined),
    'thread:delete': vi.fn().mockResolvedValue(undefined),
    'thread:list': vi.fn().mockResolvedValue([]),
    'thread:load': vi.fn().mockResolvedValue(null),
    'message:save': vi.fn().mockResolvedValue(undefined),
    'message:saveBatch': vi.fn().mockResolvedValue(undefined),
  },
})

describe('threadStore', () => {
  beforeEach(() => {
    threadCounter = 0
    useThreadStore.setState({
      threads: [],
      currentThreadId: null,
    })
  })

  it('createThread adds a thread and sets it as current', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    const state = useThreadStore.getState()
    expect(state.threads).toHaveLength(1)
    expect(state.threads[0].id).toBe(id)
    expect(state.threads[0].adapterName).toBe('claude-code')
    expect(state.threads[0].status).toBe('idle')
    expect(state.currentThreadId).toBe(id)
  })

  it('createThread with nodeBound sets the field', () => {
    useThreadStore.getState().createThread('claude-code', 'node_123')
    const thread = useThreadStore.getState().threads[0]
    expect(thread.nodeBound).toBe('node_123')
  })

  it('selectThread changes currentThreadId', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().selectThread(null)
    expect(useThreadStore.getState().currentThreadId).toBeNull()
    useThreadStore.getState().selectThread(id)
    expect(useThreadStore.getState().currentThreadId).toBe(id)
  })

  it('deleteThread removes thread and selects next', async () => {
    useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().createThread('codex')
    // Wait for async DB ID replacement
    await vi.waitFor(() => useThreadStore.getState().threads.length === 2)
    const id1 = useThreadStore.getState().threads[0].id
    await useThreadStore.getState().deleteThread(id1)
    const state = useThreadStore.getState()
    expect(state.threads).toHaveLength(1)
    expect(state.currentThreadId).toBe(state.threads[0].id)
  })

  it('deleteThread clears currentThreadId when no threads remain', async () => {
    useThreadStore.getState().createThread('claude-code')
    // Wait for async DB ID replacement
    await vi.waitFor(() => useThreadStore.getState().threads.length > 0 && useThreadStore.getState().currentThreadId !== null)
    const currentId = useThreadStore.getState().currentThreadId!
    await useThreadStore.getState().deleteThread(currentId)
    expect(useThreadStore.getState().currentThreadId).toBeNull()
  })

  it('renameThread updates the title', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().renameThread(id, 'Login Feature')
    expect(useThreadStore.getState().threads[0].title).toBe('Login Feature')
  })

  it('updateThreadStatus transitions thread status', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    expect(useThreadStore.getState().threads[0].status).toBe('idle')
    useThreadStore.getState().updateThreadStatus(id, 'running')
    expect(useThreadStore.getState().threads[0].status).toBe('running')
    useThreadStore.getState().updateThreadStatus(id, 'idle')
    expect(useThreadStore.getState().threads[0].status).toBe('idle')
  })

  it('appendChatMessage adds message to the correct thread', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'pending',
    })
    expect(useThreadStore.getState().threads[0].messages).toHaveLength(1)
    expect(useThreadStore.getState().threads[0].messages[0].content).toBe('Hello')
  })

  it('findThreadBySessionId returns the matching thread', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    // Manually set sessionId on thread
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === id ? { ...t, sessionId: 'sess-1' } : t,
      ),
    }))
    const found = useThreadStore.getState().findThreadBySessionId('sess-1')
    expect(found?.id).toBe(id)
  })

  it('findThreadBySessionId returns undefined for unknown session', () => {
    useThreadStore.getState().createThread('claude-code')
    expect(useThreadStore.getState().findThreadBySessionId('unknown')).toBeUndefined()
  })

  it('getThreadByNodeId returns the matching thread', () => {
    const id = useThreadStore.getState().createThread('claude-code', 'node_42')
    const found = useThreadStore.getState().getThreadByNodeId('node_42')
    expect(found?.id).toBe(id)
  })

  it('getThreadByNodeId returns undefined for unknown node', () => {
    useThreadStore.getState().createThread('claude-code', 'node_42')
    expect(useThreadStore.getState().getThreadByNodeId('node_99')).toBeUndefined()
  })

  it('loadThreads replaces thread list from IPC', async () => {
    const mockThreads = [
      { id: 't1', title: 'Thread 1', adapterName: 'claude-code', messages: [], contextRefs: [], status: 'idle' as const, createdAt: Date.now() },
    ]
    vi.mocked(window.electronAPI['thread:list']).mockResolvedValueOnce(mockThreads)
    await useThreadStore.getState().loadThreads()
    expect(useThreadStore.getState().threads).toEqual(mockThreads)
  })
})
