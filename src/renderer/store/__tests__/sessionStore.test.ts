import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../sessionStore'
import { useThreadStore } from '../threadStore'
import { useAdapterStore } from '../adapterStore'
import { useGraphStore } from '../graphStore'

vi.stubGlobal('window', {
  electronAPI: {
    'agent:startSession': vi.fn().mockResolvedValue({ sessionId: 's1', adapterUsed: 'claude-code', fallbackHistory: [{ adapter: 'claude-code', reason: '', success: true }] }),
    'agent:sendCommand': vi.fn().mockResolvedValue(undefined),
    'agent:resolveAndSendCommand': vi.fn().mockResolvedValue(undefined),
    'agent:terminateSession': vi.fn().mockResolvedValue(undefined),
    'agent:listAdapters': vi.fn().mockResolvedValue([]),
    'thread:create': vi.fn().mockResolvedValue({ id: 'thread-1', title: 'New Thread', adapterName: 'claude-code', messages: [], contextRefs: [], status: 'idle', createdAt: Date.now() }),
    'thread:update': vi.fn().mockResolvedValue(undefined),
    'thread:delete': vi.fn().mockResolvedValue(undefined),
    'thread:list': vi.fn().mockResolvedValue([]),
    'thread:load': vi.fn().mockResolvedValue(null),
    'message:save': vi.fn().mockResolvedValue(undefined),
    'message:saveBatch': vi.fn().mockResolvedValue(undefined),
    'settings:getAdapterPreferences': vi.fn().mockResolvedValue({ defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'mcp'] }),
    'settings:setAdapterPreferences': vi.fn().mockResolvedValue(undefined),
    onAgentStatusChange: vi.fn().mockReturnValue(() => {}),
  },
})

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessions: new Map() })
    useThreadStore.setState({ threads: [], currentThreadId: null })
    useAdapterStore.setState({
      adapters: [],
      adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'mcp'] },
      lastFallbackHistory: [],
      marketplaceItems: [],
      openSettingsPanel: false,
    })
    useGraphStore.setState({
      graphs: [{ id: 'g1', name: 'Test', type: 'online', projectPath: '/project', createdAt: '', updatedAt: '' }],
      currentGraphId: 'g1',
      nodes: [],
      edges: [],
      bugs: [],
    })
  })

  it('startSession registers an active session', async () => {
    const config = {
      workingDirectory: '/project',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: '',
      acceptanceCriteria: [],
    }
    const sessionId = await useSessionStore.getState().startSession('claude-code', config)
    expect(sessionId).toBe('s1')
    const sessionInfo = useSessionStore.getState().activeSessions.get('s1')
    expect(sessionInfo).toBeDefined()
    expect(sessionInfo?.status).toBe('active')
  })

  it('startSession with auto adapter passes null to IPC', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockResolvedValueOnce({ sessionId: 's-auto', adapterUsed: 'mcp', fallbackHistory: [{ adapter: 'claude-code', reason: 'not installed', success: false }, { adapter: 'mcp', reason: '', success: true }] })
    const config = {
      workingDirectory: '/project',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: '',
      acceptanceCriteria: [],
    }
    await useSessionStore.getState().startSession('auto', config)
    expect(window.electronAPI['agent:startSession']).toHaveBeenCalledWith(null, expect.anything())
    // Fallback history recorded in adapterStore
    expect(useAdapterStore.getState().lastFallbackHistory).toHaveLength(2)
  })

  it('terminateSession removes session from active map', async () => {
    const config = {
      workingDirectory: '/project',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: '',
      acceptanceCriteria: [],
    }
    await useSessionStore.getState().startSession('claude-code', config)
    expect(useSessionStore.getState().activeSessions.has('s1')).toBe(true)
    await useSessionStore.getState().terminateSession('s1')
    expect(useSessionStore.getState().activeSessions.has('s1')).toBe(false)
  })

  it('stopCurrentSession terminates session and marks streaming message as aborted', async () => {
    const threadId = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().updateThreadStatus(threadId, 'running')
    // Record sessionId on thread (simulates an active session)
    useThreadStore.setState({
      threads: useThreadStore.getState().threads.map((t) =>
        t.id === threadId ? { ...t, sessionId: 'sess-1' } : t,
      ),
    })
    // Add a streaming agent message
    useThreadStore.getState().appendChatMessage(threadId, {
      id: 'agent-msg-1',
      role: 'agent',
      content: 'partial output',
      timestamp: Date.now(),
      status: 'streaming',
      sessionId: 'sess-1',
    })

    await useSessionStore.getState().stopCurrentSession(threadId)

    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('idle')
    expect(thread.sessionId).toBeUndefined()
    expect(thread.messages[0].status).toBe('aborted')
    expect(thread.messages[0].content).toBe('partial output')
  })

  it('stopCurrentSession is a no-op when thread has no sessionId', async () => {
    const threadId = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().updateThreadStatus(threadId, 'running')

    await useSessionStore.getState().stopCurrentSession(threadId)

    expect(useThreadStore.getState().threads[0].status).toBe('running')
  })

  it('sendMessage adds user message and sets title from first message', async () => {
    const id = useThreadStore.getState().createThread('claude-code')
    await useSessionStore.getState().sendMessage(id, 'Implement login module')
    const thread = useThreadStore.getState().threads.find((t) => t.id === id)!
    expect(thread.messages).toHaveLength(1)
    expect(thread.messages[0].role).toBe('user')
    expect(thread.messages[0].content).toBe('Implement login module')
    expect(thread.title).toBe('Implement login module')
    expect(thread.status).toBe('running')
  })

  it('sendMessage truncates title to 30 chars', async () => {
    const id = useThreadStore.getState().createThread('claude-code')
    const longMessage = 'A'.repeat(50)
    await useSessionStore.getState().sendMessage(id, longMessage)
    expect(useThreadStore.getState().threads[0].title).toHaveLength(30)
  })

  it('sendMessage records sessionId on thread after successful start', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockResolvedValueOnce({ sessionId: 'sess-abc', adapterUsed: 'claude-code', fallbackHistory: [{ adapter: 'claude-code', reason: '', success: true }] })
    const threadId = useThreadStore.getState().createThread('claude-code')
    await useSessionStore.getState().sendMessage(threadId, 'Hello')
    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.sessionId).toBe('sess-abc')
    expect(thread.messages[0].status).toBe('pending')
  })

  it('sendMessage creates an error message on session start failure', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockRejectedValueOnce(new Error('spawn ENOENT'))
    const threadId = useThreadStore.getState().createThread('claude-code')
    await useSessionStore.getState().sendMessage(threadId, 'Hello')
    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)!
    expect(thread.status).toBe('error')
    expect(thread.messages).toHaveLength(2)
    const errMsg = thread.messages[1]
    expect(errMsg.role).toBe('agent')
    expect(errMsg.status).toBe('error')
    expect(errMsg.error?.code).toBe('SESSION_START_FAILED')
    expect(errMsg.error?.raw).toContain('ENOENT')
  })

  it('sendMessage with auto adapter passes null to startSession', async () => {
    vi.mocked(window.electronAPI['agent:startSession']).mockResolvedValueOnce({ sessionId: 'sess-auto', adapterUsed: 'mcp', fallback: true, fallbackHistory: [{ adapter: 'claude-code', reason: 'claude-code not installed', success: false }, { adapter: 'mcp', reason: '', success: true }] })
    const threadId = useThreadStore.getState().createThread('auto')
    await useSessionStore.getState().sendMessage(threadId, 'Hello')
    expect(window.electronAPI['agent:startSession']).toHaveBeenCalledWith(null, expect.anything())
    expect(useAdapterStore.getState().lastFallbackHistory).toHaveLength(2)
  })

  it('listenForStatusChanges returns a cleanup function', () => {
    const cleanup = useSessionStore.getState().listenForStatusChanges()
    expect(typeof cleanup).toBe('function')
  })
})
