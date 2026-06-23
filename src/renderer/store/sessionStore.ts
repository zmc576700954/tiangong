import { create } from 'zustand'
import type { AgentSessionConfig, AgentCommand, NodeStatus, AdapterFallbackAttempt, ContextRef, ChatMessage } from '@shared/types'
import { generateId } from '../lib/utils'
import { useGraphStore } from './graphStore'
import { useAgentOutputStore } from './agentOutputStore'
import { useAdapterStore } from './adapterStore'
import { useThreadStore } from './threadStore'
import { useMessageStore } from './messageStore'
import { eventBus, Events } from './eventBus'

interface SessionSnapshot {
  messages: Array<{ role: string; content: string }>
  filesChanged: string[]
  savedAt: number
}

interface SessionInfo {
  sessionId: string
  adapterName: string
  startTime: number
  status: 'starting' | 'active' | 'terminated' | 'crashed'
}

interface RequestStatusEntry {
  requestId: string
  status: 'queued' | 'executing' | 'done'
  adapterName: string
  enqueuedAt: number
  startedAt?: number
}

interface SessionState {
  activeSessions: Map<string, SessionInfo>
  sessionSnapshots: Map<string, SessionSnapshot>
  requestStatuses: Map<string, RequestStatusEntry>

  startSession: (adapterName: string, config: AgentSessionConfig) => Promise<string>
  resumeSession: (sessionId: string, config: AgentSessionConfig) => Promise<void>
  terminateSession: (sessionId: string) => Promise<void>
  getSessionStatus: (threadId: string) => SessionInfo | undefined
  stopCurrentSession: (threadId: string) => Promise<void>
  listenForStatusChanges: () => () => void
  listenForNodeStatusChanges: () => () => void
  /** Main message-sending logic — creates user message, starts/resumes session, sends command */
  sendMessage: (threadId: string, content: string, contextRefs?: ContextRef[], sessionConfig?: AgentSessionConfig) => Promise<void>
  /** Save a snapshot of the current session state for interrupt recovery */
  saveSnapshot: (threadId: string) => void
  /** Load a previously saved snapshot for a thread (checks in-memory Map then localStorage) */
  loadSnapshot: (threadId: string) => SessionSnapshot | null
  /** Check whether an interrupted session snapshot exists for a thread */
  hasInterruptedSession: (threadId: string) => boolean
  /** Clear a saved snapshot for a thread */
  clearSnapshot: (threadId: string) => void
  /** Track a new request in the queue */
  addRequestStatus: (requestId: string, adapterName: string) => void
  /** Update the status of a tracked request */
  updateRequestStatus: (requestId: string, status: 'queued' | 'executing' | 'done') => void
  /** Remove a tracked request */
  removeRequestStatus: (requestId: string) => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  activeSessions: new Map(),
  sessionSnapshots: new Map(),
  requestStatuses: new Map(),

  startSession: async (adapterName, config) => {
    const effectiveAdapterName = adapterName === 'auto' ? null : adapterName
    const result = await window.electronAPI['agent:startSession'](effectiveAdapterName, config)
    const sessionId = result.sessionId

    // Record fallback history
    if (result.fallbackHistory && result.fallbackHistory.length > 1) {
      useAdapterStore.setState({ lastFallbackHistory: result.fallbackHistory as AdapterFallbackAttempt[] })
    }

    // Register active session
    set((state) => {
      const next = new Map(state.activeSessions)
      next.set(sessionId, {
        sessionId,
        adapterName: result.adapterUsed ?? adapterName,
        startTime: Date.now(),
        status: 'active',
      })
      return { activeSessions: next }
    })

    return sessionId
  },

  resumeSession: async (sessionId, _config) => {
    // Resume just re-registers the session as active
    set((state) => {
      const next = new Map(state.activeSessions)
      next.set(sessionId, {
        sessionId,
        adapterName: '',
        startTime: Date.now(),
        status: 'active',
      })
      return { activeSessions: next }
    })
  },

  terminateSession: async (sessionId) => {
    await window.electronAPI['agent:terminateSession'](sessionId)
    set((state) => {
      const next = new Map(state.activeSessions)
      next.delete(sessionId)
      return { activeSessions: next }
    })
  },

  getSessionStatus: (threadId) => {
    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)
    if (!thread?.sessionId) return undefined
    return get().activeSessions.get(thread.sessionId)
  },

  stopCurrentSession: async (threadId) => {
    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)
    if (!thread?.sessionId) return

    // Save snapshot before terminating for interrupt recovery
    get().saveSnapshot(threadId)

    await window.electronAPI['agent:terminateSession'](thread.sessionId)

    // Mark the last streaming agent message as aborted
    const lastStreaming = [...thread.messages].reverse().find((m) => m.role === 'agent' && m.status === 'streaming')
    if (lastStreaming) {
      useMessageStore.getState().markMessageStatus(threadId, lastStreaming.id, 'aborted')
    }

    // 清除 sessionId 以便下次消息创建新 session
    useThreadStore.setState((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, sessionId: undefined, status: 'idle' as const } : t,
      ),
    }))

    // Unregister session
    set((state) => {
      const next = new Map(state.activeSessions)
      next.delete(thread.sessionId!)
      return { activeSessions: next }
    })

    useAgentOutputStore.getState().clearThreadOutputs(threadId)
  },

  listenForStatusChanges: () => {
    if (typeof window === 'undefined' || !window.electronAPI?.onAgentStatusChange) return () => {}
    const VALID_STATUSES: NodeStatus[] = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder']
    const cleanup = window.electronAPI.onAgentStatusChange(
      (_sessionId: string, nodeId: string, status: string) => {
        if (VALID_STATUSES.includes(status as NodeStatus)) {
          eventBus.emit(Events.AGENT_STATUS_CHANGE, nodeId, status as NodeStatus)
        }
      },
    )
    return cleanup
  },

  listenForNodeStatusChanges: () => {
    if (typeof window === 'undefined' || !window.electronAPI?.onNodeStatusChange) return () => {}
    const cleanup = window.electronAPI.onNodeStatusChange(
      (nodeId: string, oldStatus: string, newStatus: string) => {
        eventBus.emit(Events.NODE_STATUS_CHANGE, { nodeId, oldStatus, newStatus })
      },
    )
    return cleanup
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
    useThreadStore.setState((state) => ({
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
    useThreadStore.getState().persistMessage(threadId, userMessage)

    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)
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
      threadId: thread.id,
    }

    // Always ensure threadId is present (even when sessionConfig was supplied by caller).
    if (!config.threadId) {
      config.threadId = thread.id
    }

    // Determine commandType from bound node type for status auto-trigger
    if (!config.commandType && thread.nodeBound) {
      const boundNode = useGraphStore.getState().nodes.find((n) => n.id === thread.nodeBound)
      config.commandType = boundNode?.type === 'bug' ? 'fix_bug' : 'implement'
    }

    if (!config.workingDirectory) {
      useThreadStore.getState().appendChatMessage(threadId, {
        id: generateId('msg'),
        role: 'system',
        content: '请先打开一个项目目录再发送消息。',
        timestamp: Date.now(),
        status: 'error',
        error: { code: 'NO_PROJECT', message: '未指定项目目录' },
      })
      useThreadStore.getState().updateThreadStatus(threadId, 'idle')
      return
    }

    // 续接：如果 thread 有 sessionId，注入 resumeSessionId（适配器自行决定是否支持）
    if (thread.sessionId) {
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
          useAdapterStore.setState({ lastFallbackHistory: result.fallbackHistory })
        }

        // 绑定 sessionId 到 thread
        useThreadStore.setState((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, sessionId } : t,
          ),
        }))

        // 持久化 sessionId 到 DB（失败时 warn，retry 机制可容忍）
        window.electronAPI['thread:update'](threadId, { sessionId }).catch((err) => {
          console.warn('[sessionStore] Failed to persist sessionId, retry may lose continuity:', err)
        })

        // Register active session
        set((state) => {
          const next = new Map(state.activeSessions)
          next.set(sessionId, {
            sessionId,
            adapterName: result.adapterUsed ?? thread.adapterName,
            startTime: Date.now(),
            status: 'active',
          })
          return { activeSessions: next }
        })
      }

      // BUG 节点自动映射为 fix_bug 命令类型
      const boundNode = thread.nodeBound
        ? useGraphStore.getState().nodes.find((n) => n.id === thread.nodeBound)
        : undefined
      const commandType: AgentCommand['type'] = boundNode?.type === 'bug' ? 'fix_bug' : 'implement'

      const command: AgentCommand = {
        type: commandType,
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
      const errMsg = String(err)
      const isNoAdapter = errMsg.includes('No adapter available')
      useThreadStore.getState().appendChatMessage(threadId, {
        id: generateId('msg'),
        role: 'agent',
        content: '',
        timestamp: Date.now(),
        status: 'error',
        error: {
          code: isNoAdapter ? 'NO_ADAPTER_AVAILABLE' : 'SESSION_START_FAILED',
          message: isNoAdapter
            ? '没有可用的 Agent 工具，请先在设置中安装或配置一个适配器。'
            : '无法启动 Agent 会话，请检查适配器是否可用。',
          raw: errMsg,
        },
      })
      useThreadStore.getState().updateThreadStatus(threadId, 'error')
    }
  },

  saveSnapshot: (threadId) => {
    const thread = useThreadStore.getState().threads.find((t) => t.id === threadId)
    if (!thread) return

    // Get last 3 messages for context
    const messages = thread.messages.slice(-3).map((m) => ({
      role: m.role,
      content: m.content,
    }))

    // Get file changes from outputs
    const outputs = useAgentOutputStore.getState().getOutputs(threadId)
    const filesChanged = outputs
      .filter((o) => o.type === 'file_change')
      .map((o) => (o as { type: 'file_change'; filePath: string }).filePath)

    const snapshot: SessionSnapshot = {
      messages,
      filesChanged,
      savedAt: Date.now(),
    }

    // Save to in-memory Map
    set((state) => {
      const next = new Map(state.sessionSnapshots)
      next.set(threadId, snapshot)
      return { sessionSnapshots: next }
    })

    // Also persist to localStorage
    try {
      localStorage.setItem(
        `bizgraph:snapshot:${threadId}`,
        JSON.stringify(snapshot),
      )
    } catch {
      // localStorage may be unavailable; in-memory fallback is sufficient
    }
  },

  loadSnapshot: (threadId) => {
    // First check in-memory Map
    const inMemory = get().sessionSnapshots.get(threadId)
    if (inMemory) return inMemory

    // Then check localStorage
    try {
      const stored = localStorage.getItem(`bizgraph:snapshot:${threadId}`)
      if (stored) {
        const parsed = JSON.parse(stored) as SessionSnapshot
        // Basic schema validation: ensure critical fields exist
        if (parsed && Array.isArray(parsed.messages) && typeof parsed.savedAt === 'number') {
          set((state) => {
            const next = new Map(state.sessionSnapshots)
            next.set(threadId, parsed)
            return { sessionSnapshots: next }
          })
          return parsed
        }
        // Invalid snapshot — clean up
        localStorage.removeItem(`bizgraph:snapshot:${threadId}`)
      }
    } catch {
      // Ignore parse errors
    }

    return null
  },

  hasInterruptedSession: (threadId) => {
    // Check in-memory Map first
    if (get().sessionSnapshots.has(threadId)) return true
    // Then check localStorage
    try {
      return localStorage.getItem(`bizgraph:snapshot:${threadId}`) !== null
    } catch {
      return false
    }
  },

  clearSnapshot: (threadId) => {
    // Remove from in-memory Map
    set((state) => {
      const next = new Map(state.sessionSnapshots)
      next.delete(threadId)
      return { sessionSnapshots: next }
    })
    // Remove from localStorage
    try {
      localStorage.removeItem(`bizgraph:snapshot:${threadId}`)
    } catch {
      // Ignore
    }
  },

  addRequestStatus: (requestId, adapterName) => set((s) => {
    const map = new Map(s.requestStatuses)
    map.set(requestId, { requestId, status: 'queued', adapterName, enqueuedAt: Date.now() })
    return { requestStatuses: map }
  }),

  updateRequestStatus: (requestId, status) => set((s) => {
    const map = new Map(s.requestStatuses)
    const existing = map.get(requestId)
    if (existing) {
      map.set(requestId, { ...existing, status, startedAt: status === 'executing' ? Date.now() : existing.startedAt })
    }
    return { requestStatuses: map }
  }),

  removeRequestStatus: (requestId) => set((s) => {
    const map = new Map(s.requestStatuses)
    map.delete(requestId)
    return { requestStatuses: map }
  }),
}))
