import { create } from 'zustand'
import type { MessageStatus, MessageError, ToolCallBlock } from '@shared/types'
import { useThreadStore } from './threadStore'
import { eventBus, Events } from './eventBus'

// ==================== MessageQueue ====================

/** Per-thread send queue: serializes sends so only one is active at a time */
class MessageQueue {
  private active = new Map<string, boolean>()
  private queues = new Map<string, Array<{ content: string; sendFn: () => Promise<void> }>>()
  private lastSends = new Map<string, { content: string; ts: number }>()

  /** Enqueue a send function for a thread. Deduplicates same content within 5s. */
  enqueue(threadId: string, content: string, sendFn: () => Promise<void>): void {
    // Dedup: skip if same content was sent within 5 seconds
    const lastKey = `__lastSend_${threadId}`
    const lastEntry = this.lastSends.get(lastKey)
    if (lastEntry && lastEntry.content === content && Date.now() - lastEntry.ts < 5000) {
      return
    }
    this.lastSends.set(lastKey, { content, ts: Date.now() })

    if (!this.queues.has(threadId)) {
      this.queues.set(threadId, [])
    }
    this.queues.get(threadId)!.push({ content, sendFn })

    if (!this.active.get(threadId)) {
      this.drain(threadId)
    }
  }

  /** Remove all pending (not yet active) items from the queue for a thread. */
  cancelQueued(threadId: string): void {
    this.queues.delete(threadId)
  }

  private async drain(threadId: string): Promise<void> {
    while (true) {
      const queue = this.queues.get(threadId)
      if (!queue || queue.length === 0) {
        this.active.set(threadId, false)
        return
      }
      this.active.set(threadId, true)
      const item = queue.shift()!
      try {
        await item.sendFn()
      } catch {
        // Errors are handled by the caller; drain continues
      }
    }
  }
}

const messageQueue = new MessageQueue()

// ==================== Streaming dedup state ====================

/** Tracks last-seen sequence number per (threadId, messageId) for chunk dedup */
interface StreamingSeqState {
  lastSeq: Map<string, number>
}

/** Max retries per message before marking permanently_failed */
const MAX_RETRIES = 3

interface MessageState extends StreamingSeqState {
  /** Pending confirmations keyed by threadId */
  pendingConfirmations: Map<string, Map<string, { messageId: string; toolCall: ToolCallBlock }>>
  /** Per-thread AbortController for cancelling in-flight requests */
  abortControllers: Map<string, AbortController>
  /** Per-message retry count tracking */
  retryCounts: Map<string, number>

  appendToStreamingMessage: (threadId: string, messageId: string, content: string, seq?: number) => void
  appendToolCall: (threadId: string, messageId: string, toolCall: ToolCallBlock) => void
  updateToolCallAccepted: (threadId: string, messageIndex: number, toolCallIndex: number, accepted: boolean) => void
  updateAllToolCallsAccepted: (threadId: string, accepted: boolean) => void
  markMessageStatus: (threadId: string, messageId: string, status: MessageStatus, error?: MessageError) => void
  retryMessage: (threadId: string, agentMessageId: string) => Promise<void>
  /** Add a tool call to the pending confirmations map */
  addPendingConfirmation: (threadId: string, messageId: string, toolCall: ToolCallBlock) => void
  /** Confirm or reject a pending tool call, updating the message and emitting events */
  confirmToolCall: (threadId: string, toolCallId: string, accepted: boolean) => void
  /** Expose MessageQueue.enqueue for sessionStore to use */
  enqueueSend: (threadId: string, content: string, sendFn: () => Promise<void>) => void
  /** Cancel all queued (not yet active) sends for a thread */
  cancelQueued: (threadId: string) => void
  /** Abort the active in-flight request for a thread; keeps parsed file changes intact */
  abortSession: (threadId: string) => void
  /** Get the retry count for a message */
  getRetryCount: (messageId: string) => number
}

export const useMessageStore = create<MessageState>((set, get) => ({
  lastSeq: new Map(),
  pendingConfirmations: new Map(),
  abortControllers: new Map(),
  retryCounts: new Map(),

  appendToStreamingMessage: (threadId, messageId, content, seq) => {
    // Seq-based chunk dedup: if a seq number is provided and we've already
    // seen an equal or higher seq for this (threadId, messageId), skip.
    if (seq !== undefined) {
      const key = `${threadId}:${messageId}`
      const last = get().lastSeq.get(key)
      if (last !== undefined && seq <= last) return
      set((state) => {
        const next = new Map(state.lastSeq)
        next.set(key, seq)
        return { lastSeq: next }
      })
    }

    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? { ...m, content: m.content + content }
                  : m,
              ),
            }
          : t,
      ),
    }))
  },

  appendToolCall: (threadId, messageId, toolCall) => {
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
                  : m,
              ),
            }
          : t,
      ),
    }))
  },

  updateToolCallAccepted: (threadId, messageIndex, toolCallIndex, accepted) => {
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) => {
        if (t.id !== threadId) return t
        const agentMessages = t.messages.filter((m) => m.role === 'agent')
        const targetMsg = agentMessages[messageIndex]
        if (!targetMsg) return t
        return {
          ...t,
          messages: t.messages.map((m) => {
            if (m.id !== targetMsg.id) return m
            return {
              ...m,
              toolCalls: m.toolCalls?.map((tc, i) =>
                i === toolCallIndex ? { ...tc, accepted } : tc,
              ),
            }
          }),
        }
      }),
    }))
  },

  updateAllToolCallsAccepted: (threadId, accepted) => {
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) => {
        if (t.id !== threadId) return t
        return {
          ...t,
          messages: t.messages.map((m) => ({
            ...m,
            toolCalls: m.toolCalls?.map((tc) => ({ ...tc, accepted })),
          })),
        }
      }),
    }))
  },

  markMessageStatus: (threadId, messageId, status, error) => {
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? { ...m, status, ...(error ? { error } : { error: undefined }) }
                  : m,
              ),
            }
          : t,
      ),
    }))
  },

  retryMessage: async (threadId, agentMessageId) => {
    // Check retry limit
    const currentCount = get().retryCounts.get(agentMessageId) ?? 0
    if (currentCount >= MAX_RETRIES) {
      // Mark as permanently_failed
      useThreadStore.setState((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === agentMessageId
                    ? {
                        ...m,
                        status: 'permanently_failed' as MessageStatus,
                        error: {
                          code: 'RETRY_LIMIT_EXCEEDED',
                          message: '请手动重试',
                        },
                      }
                    : m,
                ),
              }
            : t,
        ),
      }))
      return
    }

    // Increment retry count
    set((state) => {
      const next = new Map(state.retryCounts)
      next.set(agentMessageId, currentCount + 1)
      return { retryCounts: next }
    })

    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)
    if (!thread) return

    const agentIdx = thread.messages.findIndex((m) => m.id === agentMessageId)
    if (agentIdx < 0) return

    // Find the preceding user message
    const precedingUser = [...thread.messages.slice(0, agentIdx)].reverse().find((m) => m.role === 'user')
    if (!precedingUser) return

    // First terminate existing session via IPC and wait for it to complete
    if (thread.sessionId) {
      try {
        await window.electronAPI['agent:terminateSession'](thread.sessionId)
      } catch {
        // Already terminated
      }
    }

    // Remove the target agent message and everything after it, and clear stale sessionId
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: t.messages.slice(0, agentIdx), sessionId: undefined }
          : t,
      ),
    }))

    // Resend using the original user message content and context
    // Dynamic import to avoid circular dependency with sessionStore
    const { useSessionStore } = await import('./sessionStore')
    await useSessionStore.getState().sendMessage(threadId, precedingUser.content, precedingUser.contextRefs)
  },

  addPendingConfirmation: (threadId, messageId, toolCall) => {
    // Generate a unique key from filePath + timestamp for the toolCall
    const toolCallId = `${toolCall.filePath ?? 'unknown'}-${Date.now()}`
    set((state) => {
      const threadMap = state.pendingConfirmations.get(threadId)
      if (!threadMap) {
        const newMap = new Map<string, { messageId: string; toolCall: ToolCallBlock }>()
        newMap.set(toolCallId, { messageId, toolCall })
        const next = new Map(state.pendingConfirmations)
        next.set(threadId, newMap)
        return { pendingConfirmations: next }
      }
      const nextThreadMap = new Map(threadMap)
      nextThreadMap.set(toolCallId, { messageId, toolCall })
      const next = new Map(state.pendingConfirmations)
      next.set(threadId, nextThreadMap)
      return { pendingConfirmations: next }
    })
  },

  confirmToolCall: (threadId, toolCallId, accepted) => {
    const state = get()
    const threadMap = state.pendingConfirmations.get(threadId)
    const pending = threadMap?.get(toolCallId)
    if (!pending) return

    const { messageId, toolCall } = pending

    // Remove from pendingConfirmations
    set((s) => {
      const tm = s.pendingConfirmations.get(threadId)
      if (!tm) return s
      const nextTm = new Map(tm)
      nextTm.delete(toolCallId)
      const next = new Map(s.pendingConfirmations)
      if (nextTm.size === 0) {
        next.delete(threadId)
      } else {
        next.set(threadId, nextTm)
      }
      return { pendingConfirmations: next }
    })

    if (accepted) {
      // Auto-accept: append the tool call to the message
      useThreadStore.setState((ts) => ({
        threads: ts.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, toolCalls: [...(m.toolCalls ?? []), { ...toolCall, accepted: true }] }
                    : m,
                ),
              }
            : t,
        ),
      }))
    } else {
      // Rejected: append the tool call marked as rejected
      useThreadStore.setState((ts) => ({
        threads: ts.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                messages: t.messages.map((m) =>
                  m.id === messageId
                    ? { ...m, toolCalls: [...(m.toolCalls ?? []), { ...toolCall, accepted: false }] }
                    : m,
                ),
              }
            : t,
        ),
      }))
    }

    // Emit CONFIRMATION_RESPONDED event
    eventBus.emit(Events.CONFIRMATION_RESPONDED, {
      threadId,
      messageId,
      toolCallId,
      accepted,
    })
  },

  enqueueSend: (threadId, content, sendFn) => {
    messageQueue.enqueue(threadId, content, sendFn)
  },

  cancelQueued: (threadId) => {
    messageQueue.cancelQueued(threadId)
  },

  abortSession: (threadId) => {
    // Cancel any queued sends for this thread
    messageQueue.cancelQueued(threadId)

    // Abort the in-flight request via AbortController
    const controller = get().abortControllers.get(threadId)
    if (controller) {
      controller.abort()
      // Remove the controller after aborting
      set((state) => {
        const next = new Map(state.abortControllers)
        next.delete(threadId)
        return { abortControllers: next }
      })
    }

    // Mark the last streaming agent message as aborted (keep parsed file changes / toolCalls intact)
    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)
    if (thread) {
      const lastStreaming = [...thread.messages].reverse().find(
        (m) => m.role === 'agent' && m.status === 'streaming',
      )
      if (lastStreaming) {
        get().markMessageStatus(threadId, lastStreaming.id, 'aborted')
      }
    }
  },

  getRetryCount: (messageId) => {
    return get().retryCounts.get(messageId) ?? 0
  },
}))
