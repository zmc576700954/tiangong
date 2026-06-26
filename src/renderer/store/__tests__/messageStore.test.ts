import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useMessageStore } from '../messageStore'
import { useThreadStore } from '../threadStore'

// The streaming message store uses RAF batching. In tests, requestAnimationFrame
// may not fire, so we need to flush the buffer manually.
// We access the internal flush function by triggering it via a fake RAF.
function flushStreamingBuffer() {
  // Trigger any pending RAF callbacks
  vi.advanceTimersByTime(16)
}

vi.stubGlobal('window', {
  electronAPI: {
    'agent:terminateSession': vi.fn().mockResolvedValue(undefined),
    'agent:startSession': vi.fn().mockResolvedValue({ sessionId: 's1', adapterUsed: 'claude-code', fallbackHistory: [{ adapter: 'claude-code', reason: '', success: true }] }),
    'agent:sendCommand': vi.fn().mockResolvedValue(undefined),
    'agent:resolveAndSendCommand': vi.fn().mockResolvedValue(undefined),
    'thread:create': vi.fn().mockResolvedValue({ id: 'thread-1', title: 'New Thread', adapterName: 'claude-code', messages: [], contextRefs: [], status: 'idle', createdAt: Date.now() }),
    'thread:update': vi.fn().mockResolvedValue(undefined),
    'thread:delete': vi.fn().mockResolvedValue(undefined),
    'thread:list': vi.fn().mockResolvedValue([]),
    'thread:load': vi.fn().mockResolvedValue(null),
    'message:save': vi.fn().mockResolvedValue(undefined),
    'message:saveBatch': vi.fn().mockResolvedValue(undefined),
    'settings:getAdapterPreferences': vi.fn().mockResolvedValue({ defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'mcp'] }),
    'settings:setAdapterPreferences': vi.fn().mockResolvedValue(undefined),
  },
})

describe('messageStore', () => {
  beforeEach(() => {
    useMessageStore.setState({
      lastSeq: new Map(),
      pendingConfirmations: new Map(),
      retryCounts: new Map(),
    })
    useThreadStore.setState({
      threads: [],
      currentThreadId: null,
      threadIdResolvers: new Map(),
      nodeThreadMap: new Map(),
    })
  })

describe('streaming (RAF-batched)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useMessageStore.setState({
      lastSeq: new Map(),
      pendingConfirmations: new Map(),
      retryCounts: new Map(),
    })
    useThreadStore.setState({
      threads: [],
      currentThreadId: null,
      threadIdResolvers: new Map(),
      nodeThreadMap: new Map(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('appendToStreamingMessage appends content to the target message', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-stream',
      role: 'agent',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useMessageStore.getState().appendToStreamingMessage(id, 'msg-stream', ' World')
    flushStreamingBuffer()
    expect(useThreadStore.getState().threads[0].messages[0].content).toBe('Hello World')
  })

  it('appendToStreamingMessage with seq dedup drops duplicate chunks', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-dedup',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
    })
    // Send seq=1 first time — should be accepted
    useMessageStore.getState().appendToStreamingMessage(id, 'msg-dedup', 'A', 1)
    flushStreamingBuffer()
    expect(useThreadStore.getState().threads[0].messages[0].content).toBe('A')

    // Send seq=1 again — should be deduplicated (skipped)
    useMessageStore.getState().appendToStreamingMessage(id, 'msg-dedup', 'B', 1)
    flushStreamingBuffer()
    expect(useThreadStore.getState().threads[0].messages[0].content).toBe('A')

    // Send seq=2 — should be accepted (higher seq)
    useMessageStore.getState().appendToStreamingMessage(id, 'msg-dedup', 'C', 2)
    flushStreamingBuffer()
    expect(useThreadStore.getState().threads[0].messages[0].content).toBe('AC')

    // Send seq=0 — should be deduplicated (lower seq than last=2)
    useMessageStore.getState().appendToStreamingMessage(id, 'msg-dedup', 'D', 0)
    flushStreamingBuffer()
    expect(useThreadStore.getState().threads[0].messages[0].content).toBe('AC')
  })
})

  it('appendToolCall adds a tool call block to the message', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-toolcall',
      role: 'agent',
      content: 'Doing work',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useMessageStore.getState().appendToolCall(id, 'msg-toolcall', {
      type: 'file_edit',
      filePath: '/foo.ts',
      content: 'changed',
      status: 'done',
      accepted: false,
    })
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.toolCalls).toHaveLength(1)
    expect(msg.toolCalls![0].type).toBe('file_edit')
  })

  it('markMessageStatus updates a specific message status', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-status',
      role: 'agent',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useMessageStore.getState().markMessageStatus(id, 'msg-status', 'success')
    expect(useThreadStore.getState().threads[0].messages[0].status).toBe('success')
  })

  it('markMessageStatus sets error with MessageError object', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-err',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
    })
    useMessageStore.getState().markMessageStatus(id, 'msg-err', 'error', {
      code: 'AGENT_CRASH',
      message: 'Process crashed',
    })
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.status).toBe('error')
    expect(msg.error?.code).toBe('AGENT_CRASH')
    expect(msg.error?.message).toBe('Process crashed')
  })

  it('updateToolCallAccepted updates a specific tool call', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-tc2',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [
        { type: 'file_edit', content: 'a', status: 'done', accepted: false },
        { type: 'terminal', content: 'b', status: 'done', accepted: false },
      ],
    })
    useMessageStore.getState().updateToolCallAccepted(id, 0, 1, true)
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.toolCalls![1].accepted).toBe(true)
    expect(msg.toolCalls![0].accepted).toBe(false)
  })

  it('updateAllToolCallsAccepted sets all tool calls accepted', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-tc3',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [
        { type: 'file_edit', content: 'a', status: 'done', accepted: false },
        { type: 'terminal', content: 'b', status: 'done', accepted: false },
      ],
    })
    useMessageStore.getState().updateAllToolCallsAccepted(id, true)
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.toolCalls!.every((tc) => tc.accepted)).toBe(true)
  })

  it('addPendingConfirmation stores tool call in pending map', () => {
    const toolCall = { type: 'file_edit' as const, filePath: '/.env', content: 'KEY=val', status: 'done' as const }
    useMessageStore.getState().addPendingConfirmation('thread-1', 'msg-1', toolCall)
    const state = useMessageStore.getState()
    const threadMap = state.pendingConfirmations.get('thread-1')
    expect(threadMap).toBeDefined()
    // There should be one entry with the toolCall data
    const entries = Array.from(threadMap!.values())
    expect(entries).toHaveLength(1)
    expect(entries[0].messageId).toBe('msg-1')
    expect(entries[0].toolCall.filePath).toBe('/.env')
  })

  it('confirmToolCall accepts a pending tool call and appends it to the message', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-confirm',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
    })
    const toolCall = { type: 'file_edit' as const, filePath: '/.env', content: 'KEY=val', status: 'done' as const }
    useMessageStore.getState().addPendingConfirmation(id, 'msg-confirm', toolCall)

    // Get the toolCallId from pendingConfirmations
    const threadMap = useMessageStore.getState().pendingConfirmations.get(id)
    const toolCallId = Array.from(threadMap!.keys())[0]

    // Accept the tool call
    useMessageStore.getState().confirmToolCall(id, toolCallId, true)

    // Should be removed from pending
    expect(useMessageStore.getState().pendingConfirmations.get(id)).toBeUndefined()

    // Should be appended to the message with accepted: true
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.toolCalls).toHaveLength(1)
    expect(msg.toolCalls![0].accepted).toBe(true)
    expect(msg.toolCalls![0].filePath).toBe('/.env')
  })

  it('confirmToolCall rejects a pending tool call and marks it as rejected', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-reject',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
    })
    const toolCall = { type: 'file_edit' as const, filePath: '/tsconfig.json', content: '{}', status: 'done' as const }
    useMessageStore.getState().addPendingConfirmation(id, 'msg-reject', toolCall)

    const threadMap = useMessageStore.getState().pendingConfirmations.get(id)
    const toolCallId = Array.from(threadMap!.keys())[0]

    // Reject the tool call
    useMessageStore.getState().confirmToolCall(id, toolCallId, false)

    // Should be removed from pending
    expect(useMessageStore.getState().pendingConfirmations.get(id)).toBeUndefined()

    // Should be appended to the message with accepted: false
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.toolCalls).toHaveLength(1)
    expect(msg.toolCalls![0].accepted).toBe(false)
  })

  it('confirmToolCall is a no-op for unknown toolCallId', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'msg-noop',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [],
    })
    // Confirm a non-existent tool call — should not crash or modify anything
    useMessageStore.getState().confirmToolCall(id, 'nonexistent-tc', true)
    const msg = useThreadStore.getState().threads[0].messages[0]
    expect(msg.toolCalls).toHaveLength(0)
  })

  it('MessageQueue enqueueSend serializes per-thread (calls sequentially)', async () => {
    const order: number[] = []
    const makeSend = (n: number) => () => new Promise<void>((resolve) => {
      order.push(n)
      resolve()
    })
    // Enqueue two sends for the same thread
    useMessageStore.getState().enqueueSend('t1', 'msg-a', makeSend(1))
    useMessageStore.getState().enqueueSend('t1', 'msg-b', makeSend(2))
    // Give microtasks time to drain
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual([1, 2])
  })

  it('getRetryCount returns current retry count', () => {
    useMessageStore.setState({ retryCounts: new Map([['m1', 2]]) })
    expect(useMessageStore.getState().getRetryCount('m1')).toBe(2)
    expect(useMessageStore.getState().getRetryCount('m2')).toBe(0)
  })

  it('retryMessage marks permanently_failed after max retries', () => {
    const id = useThreadStore.getState().createThread('claude-code')
    useThreadStore.getState().appendChatMessage(id, {
      id: 'u1',
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
      status: 'success',
    })
    useThreadStore.getState().appendChatMessage(id, {
      id: 'm1',
      role: 'agent',
      content: '',
      timestamp: Date.now(),
      status: 'error',
    })
    useMessageStore.setState({ retryCounts: new Map([['m1', 3]]) })
    useMessageStore.getState().retryMessage(id, 'm1')
    const msg = useThreadStore.getState().threads[0].messages.find((m) => m.id === 'm1')
    expect(msg?.status).toBe('permanently_failed')
    expect(msg?.error?.code).toBe('RETRY_LIMIT_EXCEEDED')
  })
})
