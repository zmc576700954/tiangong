import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '../agentStore'

vi.stubGlobal('window', {
  electronAPI: {
    'agent:startSession': vi.fn().mockResolvedValue({ sessionId: 's1' }),
    'agent:sendCommand': vi.fn().mockResolvedValue(undefined),
    'agent:resolveAndSendCommand': vi.fn().mockResolvedValue(undefined),
    'agent:listAdapters': vi.fn().mockResolvedValue([]),
    'agent:terminateSession': vi.fn().mockResolvedValue(undefined),
    'thread:list': vi.fn().mockResolvedValue([]),
    'thread:load': vi.fn().mockResolvedValue(null),
    'thread:create': vi.fn().mockResolvedValue({ id: 'thread-1', title: 'New Thread', adapterName: 'claude-code', messages: [], contextRefs: [], status: 'idle', createdAt: Date.now() }),
    'thread:update': vi.fn().mockResolvedValue(undefined),
    'thread:delete': vi.fn().mockResolvedValue(undefined),
    'thread:search': vi.fn().mockResolvedValue([]),
    'message:list': vi.fn().mockResolvedValue([]),
    'message:save': vi.fn().mockResolvedValue(undefined),
    'message:saveBatch': vi.fn().mockResolvedValue(undefined),
    onAgentOutput: vi.fn(),
    onSessionStarted: vi.fn(),
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
      status: 'pending',
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

  it('appendChatMessage sets status to pending for user messages', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-user',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'pending',
    })
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('pending')
  })

  it('appendChatMessage sets status to streaming for agent messages', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-agent',
      role: 'agent',
      content: 'Response',
      timestamp: Date.now(),
      status: 'streaming',
    })
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('streaming')
  })

  it('markMessageStatus updates a specific message status', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'agent',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useAgentStore.getState().markMessageStatus(id, 'msg-1', 'success')
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('success')
  })

  it('markMessageStatus sets error with MessageError object', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-err',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useAgentStore.getState().markMessageStatus(id, 'msg-err', 'error', {
      code: 'AGENT_CRASH',
      message: 'Process crashed',
    })
    const msg = useAgentStore.getState().threads[0].messages[0]
    expect(msg.status).toBe('error')
    expect(msg.error?.code).toBe('AGENT_CRASH')
    expect(msg.error?.message).toBe('Process crashed')
  })

  it('markMessageStatus is a no-op for non-existent message', () => {
    const id = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(id, {
      id: 'msg-1',
      role: 'agent',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useAgentStore.getState().markMessageStatus(id, 'non-existent', 'error')
    expect(useAgentStore.getState().threads[0].messages[0].status).toBe('streaming')
  })

  it('stopCurrentSession terminates session and marks streaming message as aborted', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    // Simulate an active session
    useAgentStore.setState({
      sessions: [{
        id: 'sess-1',
        adapterName: 'claude-code',
        nodeId: 'node-1',
        status: 'running',
        outputs: [],
        startTime: Date.now(),
      }],
    })
    useAgentStore.getState().updateThreadStatus(threadId, 'running')
    // Record sessionId on thread
    useAgentStore.setState({
      threads: useAgentStore.getState().threads.map((t) =>
        t.id === threadId ? { ...t, sessionId: 'sess-1' } : t,
      ),
    })
    // Add a streaming agent message
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'agent-msg-1',
      role: 'agent',
      content: 'partial output',
      timestamp: Date.now(),
      status: 'streaming',
      sessionId: 'sess-1',
    })

    await useAgentStore.getState().stopCurrentSession(threadId)

    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('idle')
    expect(thread.messages[0].status).toBe('aborted')
    expect(thread.messages[0].content).toBe('partial output')
  })

  it('stopCurrentSession is a no-op when thread has no sessionId', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().updateThreadStatus(threadId, 'running')

    await useAgentStore.getState().stopCurrentSession(threadId)

    expect(useAgentStore.getState().threads[0].status).toBe('running')
  })

  it('retryMessage removes agent message and all subsequent messages, resends user message', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    // Add user message + agent message
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'user-1',
      role: 'user',
      content: 'Implement login',
      timestamp: Date.now(),
      status: 'pending',
      contextRefs: [{ type: 'node', id: 'node-1', label: 'Login' }],
    })
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'agent-1',
      role: 'agent',
      content: 'Error occurred',
      timestamp: Date.now(),
      status: 'error',
      error: { code: 'AGENT_CRASH', message: 'crashed' },
    })

    await useAgentStore.getState().retryMessage(threadId, 'agent-1')

    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('running')
    const userMessages = thread.messages.filter((m) => m.role === 'user')
    expect(userMessages.some((m) => m.content === 'Implement login')).toBe(true)
  })

  it('retryMessage does nothing if target message has no preceding user message', async () => {
    const threadId = useAgentStore.getState().createThread('claude-code')
    useAgentStore.getState().appendChatMessage(threadId, {
      id: 'agent-only',
      role: 'agent',
      content: 'orphan',
      timestamp: Date.now(),
      status: 'error',
      error: { code: 'UNKNOWN', message: 'unknown' },
    })

    await useAgentStore.getState().retryMessage(threadId, 'agent-only')

    expect(useAgentStore.getState().threads[0].status).toBe('idle')
  })

  it('sendMessage records sessionId on thread after successful start', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockResolvedValueOnce({ sessionId: 'sess-abc' })
    const threadId = useAgentStore.getState().createThread('claude-code')
    await useAgentStore.getState().sendMessage(threadId, 'Hello')
    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.sessionId).toBe('sess-abc')
    expect(thread.messages[0].status).toBe('pending')
  })

  it('sendMessage creates an error message on session start failure', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockRejectedValueOnce(new Error('spawn ENOENT'))
    const threadId = useAgentStore.getState().createThread('claude-code')
    await useAgentStore.getState().sendMessage(threadId, 'Hello')
    const thread = useAgentStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('error')
    expect(thread.messages).toHaveLength(2)
    const errMsg = thread.messages[1]
    expect(errMsg.role).toBe('agent')
    expect(errMsg.status).toBe('error')
    expect(errMsg.error?.code).toBe('SESSION_START_FAILED')
    expect(errMsg.error?.raw).toContain('ENOENT')
  })
})
