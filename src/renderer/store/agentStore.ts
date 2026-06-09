import { create } from 'zustand'
import type { AgentOutput, AgentSessionConfig, AgentCommand, ChatMessage, AgentThread, ContextRef, MessageStatus, MessageError, ToolCallBlock, NodeStatus, AdapterPreferences, AdapterFallbackAttempt } from '@shared/types'
import { generateId } from '../lib/utils'
import { useGraphStore } from './graphStore'

/** 单个 thread 的输出上限，防止长时间运行导致内存膨胀 */
const MAX_OUTPUTS_PER_THREAD = 1000

/** 批处理缓冲区 - 不在 store state 中，避免触发渲染 */
let outputBuffer: Array<{ threadId: string; output: AgentOutput }> = []
let flushScheduled = false
const BATCH_INTERVAL = 16 // ~1 frame at 60fps

/** 将缓冲区中的输出批量写入 store，合并为一次状态更新 */
function flushOutputBuffer() {
  flushScheduled = false
  if (outputBuffer.length === 0) return

  const batch = outputBuffer
  outputBuffer = []

  useAgentStore.setState((state) => {
    const newOutputs = { ...state.threadOutputs }
    let threads = state.threads
    const errorThreadIds = new Set<string>()

    for (const { threadId, output } of batch) {
      const existing = newOutputs[threadId] ?? []
      newOutputs[threadId] = [...existing, output].slice(-MAX_OUTPUTS_PER_THREAD)
      if (output.type === 'error') {
        errorThreadIds.add(threadId)
      }
    }

    if (errorThreadIds.size > 0) {
      threads = threads.map((t) =>
        errorThreadIds.has(t.id) ? { ...t, status: 'error' as const } : t,
      )
    }

    return { threadOutputs: newOutputs, threads }
  })
}

/** 调度一次 flush（如果尚未调度） */
function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flushOutputBuffer)
  } else {
    setTimeout(flushOutputBuffer, BATCH_INTERVAL)
  }
}

interface AgentState {
  adapters: { name: string; version: string; installed: boolean }[]
  threads: AgentThread[]
  currentThreadId: string | null
  /** 每个 thread 的 agent 原始输出（用于 TerminalView） */
  threadOutputs: Record<string, AgentOutput[]>
  /** 适配器偏好配置 */
  adapterPreferences: AdapterPreferences
  /** 最近一次 startSession 的回退历史（用于 UI 展示） */
  lastFallbackHistory: AdapterFallbackAttempt[]

  loadAdapters: () => Promise<void>
  loadAdapterPreferences: () => Promise<void>
  setAdapterPreferences: (prefs: AdapterPreferences) => Promise<void>
  sendCommand: (sessionId: string, command: AgentCommand) => Promise<void>
  appendOutput: (threadId: string, output: AgentOutput) => void
  appendToStreamingMessage: (threadId: string, messageId: string, content: string) => void
  clearThreadOutputs: (threadId: string) => void
  trimInactiveThreadOutputs: (activeThreadId: string) => void
  appendToolCall: (threadId: string, messageId: string, toolCall: ToolCallBlock) => void
  updateToolCallAccepted: (threadId: string, messageIndex: number, toolCallIndex: number, accepted: boolean) => void
  updateAllToolCallsAccepted: (threadId: string, accepted: boolean) => void
  getOutputs: (threadId: string) => AgentOutput[]
  createThread: (adapterName: string, nodeBound?: string) => string
  sendMessage: (threadId: string, content: string, contextRefs?: ContextRef[], sessionConfig?: AgentSessionConfig) => Promise<void>
  appendChatMessage: (threadId: string, message: ChatMessage) => void
  renameThread: (threadId: string, title: string) => void
  deleteThread: (threadId: string) => void
  selectThread: (id: string | null) => void
  updateThreadStatus: (threadId: string, status: 'idle' | 'running' | 'error' | 'reviewed') => void
  markMessageStatus: (threadId: string, messageId: string, status: MessageStatus, error?: MessageError) => void
  stopCurrentSession: (threadId: string) => Promise<void>
  retryMessage: (threadId: string, agentMessageId: string) => Promise<void>
  findThreadBySessionId: (sessionId: string) => AgentThread | undefined

  // 持久化相关
  loadThreads: (filters?: { nodeId?: string; graphId?: string }) => Promise<void>
  loadMessages: (threadId: string) => Promise<void>
  persistMessage: (threadId: string, message: ChatMessage) => Promise<void>
  persistThreadMessages: (threadId: string) => Promise<void>
  hydrateOnStart: () => Promise<void>
  listenForStatusChanges: () => () => void
}

export const useAgentStore = create<AgentState>((set, get) => ({
  adapters: [],
  threads: [],
  currentThreadId: null,
  threadOutputs: {},
  adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'mcp'] },
  lastFallbackHistory: [],

  loadAdapters: async () => {
    const adapters = await window.electronAPI['agent:listAdapters']()
    set({ adapters })
  },

  loadAdapterPreferences: async () => {
    try {
      const prefs = await window.electronAPI['settings:getAdapterPreferences']()
      set({ adapterPreferences: prefs })
    } catch (err) {
      console.error('[agentStore] Failed to load adapter preferences:', err)
    }
  },

  setAdapterPreferences: async (prefs) => {
    try {
      await window.electronAPI['settings:setAdapterPreferences'](prefs)
      set({ adapterPreferences: prefs })
    } catch (err) {
      console.error('[agentStore] Failed to save adapter preferences:', err)
    }
  },

  sendCommand: async (sessionId, command) => {
    await window.electronAPI['agent:sendCommand'](sessionId, command)
  },

  appendOutput: (threadId, output) => {
    // 对 error 类型输出立即 flush，确保错误状态不延迟显示
    if (output.type === 'error') {
      outputBuffer.push({ threadId, output })
      flushOutputBuffer()
      return
    }
    outputBuffer.push({ threadId, output })
    scheduleFlush()
  },

  appendToStreamingMessage: (threadId, messageId, content) => {
    set((state) => ({
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

  clearThreadOutputs: (threadId) => {
    // 同时清理缓冲区中对应 thread 的条目
    outputBuffer = outputBuffer.filter((entry) => entry.threadId !== threadId)
    set((state) => {
      if (!(threadId in state.threadOutputs)) return state
      const { [threadId]: _removed, ...rest } = state.threadOutputs
      return { threadOutputs: rest }
    })
  },

  trimInactiveThreadOutputs: (activeThreadId) => {
    const TRIM_TO = 100
    set((state) => {
      let changed = false
      const updated: Record<string, AgentOutput[]> = {}
      for (const [tid, outputs] of Object.entries(state.threadOutputs)) {
        if (tid !== activeThreadId && outputs.length > TRIM_TO) {
          updated[tid] = outputs.slice(-TRIM_TO)
          changed = true
        }
      }
      return changed
        ? { threadOutputs: { ...state.threadOutputs, ...updated } }
        : state
    })
  },

  appendToolCall: (threadId, messageId, toolCall) => {
    set((state) => ({
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
    set((state) => ({
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
    set((state) => ({
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

  getOutputs: (threadId) => {
    return get().threadOutputs[threadId] ?? []
  },

  createThread: (adapterName, nodeBound) => {
    const id = generateId('thread')
    const thread: AgentThread = {
      id,
      title: 'New Thread',
      adapterName,
      messages: [],
      contextRefs: [],
      status: 'idle',
      createdAt: Date.now(),
      nodeBound,
    }
    set((state) => ({
      threads: [...state.threads, thread],
      currentThreadId: id,
    }))
    // 异步持久化到 DB，失败时标记 thread 状态提醒用户
    window.electronAPI['thread:create']({ adapterName, nodeId: nodeBound }).catch((err) => {
      console.error('[agentStore] Failed to persist new thread:', err)
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === id ? { ...t, status: 'error' as const } : t,
        ),
      }))
    })
    return id
  },

  sendMessage: async (threadId, content, contextRefs, sessionConfig) => {
    const userMessage: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content,
      timestamp: Date.now(),
      contextRefs,
      status: 'pending',
    }
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: [...t.messages, userMessage],
              title: t.title === 'New Thread' ? content.slice(0, 30) : t.title,
              status: 'running' as const,
            }
          : t,
      ),
    }))

    // 持久化用户消息到 DB
    get().persistMessage(threadId, userMessage)

    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    // 使用传入的完整配置，或构建 fallback（从 graphStore 获取 projectPath）
    const graphState = useGraphStore.getState()
    const currentGraph = graphState.currentGraphId
      ? graphState.graphs.find((g) => g.id === graphState.currentGraphId)
      : undefined
    const config: AgentSessionConfig = sessionConfig ?? {
      workingDirectory: currentGraph?.projectPath ?? '',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: thread.nodeBound ?? '',
      nodeId: thread.nodeBound,
      acceptanceCriteria: [],
    }

    if (!config.workingDirectory) {
      get().appendChatMessage(threadId, {
        id: generateId('msg'),
        role: 'system',
        content: '请先打开一个项目目录再发送消息。',
        timestamp: Date.now(),
        status: 'error',
        error: { code: 'NO_PROJECT', message: '未指定项目目录' },
      })
      get().updateThreadStatus(threadId, 'idle')
      return
    }

    // 续接：如果 thread 有 sessionId 且 adapter 是 claude-code，注入 resumeSessionId
    if (thread.sessionId && thread.adapterName === 'claude-code') {
      config.resumeSessionId = thread.sessionId
    }

    try {
      let sessionId: string
      const existingSessionId = thread.sessionId

      if (existingSessionId) {
        // 复用已有 session
        sessionId = existingSessionId
      } else {
        // 首次发送，创建 session
        // adapterName 为 'auto' 时传 null，触发主进程自动回退链
        const effectiveAdapterName = thread.adapterName === 'auto' ? null : thread.adapterName
        const result = await window.electronAPI['agent:startSession'](effectiveAdapterName, config)
        sessionId = result.sessionId

        // 记录回退历史
        if (result.fallbackHistory && result.fallbackHistory.length > 1) {
          set({ lastFallbackHistory: result.fallbackHistory })
        }

        // 绑定 sessionId 到 thread
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, sessionId } : t,
          ),
        }))

        // 持久化 sessionId 到 DB（失败时 warn，retry 机制可容忍）
        window.electronAPI['thread:update'](threadId, { sessionId }).catch((err) => {
          console.warn('[agentStore] Failed to persist sessionId, retry may lose continuity:', err)
        })
      }

      const command: AgentCommand = {
        type: 'implement',
        description: content,
        targetNodeId: thread.nodeBound ?? '',
      }

      // Use resolveAndSendCommand if contextRefs exist, otherwise fall back to sendCommand
      if (contextRefs && contextRefs.length > 0) {
        const nodeIds = contextRefs.filter((r) => r.type === 'node').map((r) => r.id)
        await window.electronAPI['agent:resolveAndSendCommand'](
          sessionId,
          command,
          contextRefs,
          nodeIds,
        )
      } else {
        await window.electronAPI['agent:sendCommand'](sessionId, command)
      }
    } catch (err) {
      get().appendChatMessage(threadId, {
        id: generateId('msg'),
        role: 'agent',
        content: '',
        timestamp: Date.now(),
        status: 'error',
        error: {
          code: 'SESSION_START_FAILED',
          message: '无法启动 Agent 会话，请检查适配器是否可用。',
          raw: String(err),
        },
      })
      get().updateThreadStatus(threadId, 'error')
    }
  },

  appendChatMessage: (threadId, message) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: [...t.messages, message] }
          : t,
      ),
    }))
  },

  renameThread: (threadId, title) => {
    const prevTitle = get().threads.find((t) => t.id === threadId)?.title
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, title } : t,
      ),
    }))
    window.electronAPI['thread:update'](threadId, { title }).catch((err) => {
      console.error('[agentStore] Failed to persist thread rename:', err)
      if (prevTitle) {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, title: prevTitle } : t,
          ),
        }))
      }
    })
  },

  deleteThread: async (threadId) => {
    try {
      await window.electronAPI['thread:delete'](threadId)
    } catch (err) {
      console.error('[agentStore] Failed to delete thread from DB:', err)
    }
    // 无论 DB 是否成功都从 UI 移除（避免阻塞用户操作）
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== threadId),
      currentThreadId:
        state.currentThreadId === threadId
          ? state.threads.find((t) => t.id !== threadId)?.id ?? null
          : state.currentThreadId,
    }))
  },

  selectThread: (id) => {
    set({ currentThreadId: id })
    if (id) get().trimInactiveThreadOutputs(id)
  },

  updateThreadStatus: (threadId, status) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, status } : t,
      ),
    }))
  },

  markMessageStatus: (threadId, messageId, status, error) => {
    set((state) => ({
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

  stopCurrentSession: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread?.sessionId) return

    await window.electronAPI['agent:terminateSession'](thread.sessionId)

    // Mark the last streaming agent message as aborted
    const lastStreaming = [...thread.messages].reverse().find((m) => m.role === 'agent' && m.status === 'streaming')
    if (lastStreaming) {
      get().markMessageStatus(threadId, lastStreaming.id, 'aborted')
    }

    // 清除 sessionId 以便下次消息创建新 session
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, sessionId: undefined, status: 'idle' as const } : t,
      ),
    }))
    get().clearThreadOutputs(threadId)
  },

  retryMessage: async (threadId, agentMessageId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    const agentIdx = thread.messages.findIndex((m) => m.id === agentMessageId)
    if (agentIdx < 0) return

    // Find the preceding user message
    const precedingUser = [...thread.messages.slice(0, agentIdx)].reverse().find((m) => m.role === 'user')
    if (!precedingUser) return

    // Terminate existing session if any
    if (thread.sessionId) {
      try {
        await window.electronAPI['agent:terminateSession'](thread.sessionId)
      } catch {
        // Already terminated
      }
    }

    // Remove the target agent message and everything after it, and clear stale sessionId
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: t.messages.slice(0, agentIdx), sessionId: undefined }
          : t,
      ),
    }))

    // Resend using the original user message content and context
    await get().sendMessage(threadId, precedingUser.content, precedingUser.contextRefs)
  },

  findThreadBySessionId: (sessionId) => {
    return get().threads.find((t) => t.sessionId === sessionId)
  },

  // ==================== 持久化 ====================

  loadThreads: async (filters) => {
    const threads = await window.electronAPI['thread:list'](filters)
    set({ threads })
  },

  loadMessages: async (threadId) => {
    const thread = await window.electronAPI['thread:load'](threadId)
    if (!thread) return
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? thread : t,
      ),
    }))
  },

  persistMessage: async (threadId, message) => {
    try {
      await window.electronAPI['message:save'](threadId, message)
    } catch (err) {
      console.error('[agentStore] Failed to persist message:', err)
    }
  },

  persistThreadMessages: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return
    try {
      await window.electronAPI['message:saveBatch'](threadId, thread.messages)
    } catch (err) {
      console.error('[agentStore] Failed to persist thread messages:', err)
    }
  },

  hydrateOnStart: async () => {
    try {
      const threads = await window.electronAPI['thread:list']()
      if (threads.length > 0) {
        set({ threads, currentThreadId: threads[0].id })
      }
    } catch (err) {
      console.error('[agentStore] Failed to hydrate threads:', err)
    }
    // 加载适配器偏好
    get().loadAdapterPreferences()
  },

  listenForStatusChanges: () => {
    if (typeof window === 'undefined' || !window.electronAPI?.onAgentStatusChange) return () => {}
    const VALID_STATUSES: NodeStatus[] = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder']
    const cleanup = window.electronAPI.onAgentStatusChange(
      (_sessionId: string, nodeId: string, status: string) => {
        if (VALID_STATUSES.includes(status as NodeStatus)) {
          useGraphStore.getState().updateNode(nodeId, { status: status as NodeStatus })
        }
      },
    )
    return cleanup
  },
}))
