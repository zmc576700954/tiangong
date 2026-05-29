import { create } from 'zustand'
import type { AgentOutput, AgentSessionConfig, AgentCommand, ChatMessage, AgentThread, ContextRef, MessageStatus, MessageError } from '@shared/types'
import { generateId } from '../lib/utils'

/** 单个会话的输出上限，防止长时间运行导致内存膨胀 */
const MAX_OUTPUTS_PER_SESSION = 1000

interface AgentSessionState {
  id: string
  adapterName: string
  nodeId: string
  status: 'running' | 'completed' | 'error'
  outputs: AgentOutput[]
  startTime: number
  endTime?: number
  /** 是否 fallback 到 mcp adapter */
  fallback?: boolean
}

interface AgentState {
  adapters: { name: string; version: string; installed: boolean }[]
  sessions: AgentSessionState[]
  currentSessionId: string | null
  threads: AgentThread[]
  currentThreadId: string | null

  loadAdapters: () => Promise<void>
  startSession: (adapterName: string, config: AgentSessionConfig, nodeId: string) => Promise<string>
  sendCommand: (sessionId: string, command: AgentCommand) => Promise<void>
  terminateSession: (sessionId: string) => Promise<void>
  appendOutput: (sessionId: string, output: AgentOutput) => void
  selectSession: (id: string | null) => void
  createThread: (adapterName: string, nodeBound?: string) => string
  sendMessage: (threadId: string, content: string, contextRefs?: ContextRef[], sessionConfig?: AgentSessionConfig) => Promise<void>
  appendChatMessage: (threadId: string, message: ChatMessage) => void
  renameThread: (threadId: string, title: string) => void
  deleteThread: (threadId: string) => void
  selectThread: (id: string | null) => void
  updateThreadStatus: (threadId: string, status: 'idle' | 'running' | 'error') => void
  markMessageStatus: (threadId: string, messageId: string, status: MessageStatus, error?: MessageError) => void
  stopCurrentSession: (threadId: string) => Promise<void>
  retryMessage: (threadId: string, agentMessageId: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  adapters: [],
  sessions: [],
  currentSessionId: null,

  loadAdapters: async () => {
    const adapters = await window.electronAPI['agent:listAdapters']()
    set({ adapters })
  },

  startSession: async (adapterName, config, nodeId) => {
    const result = await window.electronAPI['agent:startSession'](adapterName, config)
    const session: AgentSessionState = {
      id: result.sessionId,
      adapterName: result.fallback ? 'mcp' : adapterName,
      nodeId,
      status: 'running',
      outputs: [],
      startTime: Date.now(),
      fallback: result.fallback,
    }
    set((state) => ({
      sessions: [...state.sessions, session],
      currentSessionId: result.sessionId,
    }))
    return result.sessionId
  },

  sendCommand: async (sessionId, command) => {
    await window.electronAPI['agent:sendCommand'](sessionId, command)
  },

  terminateSession: async (sessionId) => {
    await window.electronAPI['agent:terminateSession'](sessionId)
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, status: 'completed' as const, endTime: Date.now() }
          : s,
      ),
    }))
  },

  appendOutput: (sessionId, output) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              outputs: [...s.outputs, output].slice(-MAX_OUTPUTS_PER_SESSION),
              status: output.type === 'error' ? 'error' : s.status,
            }
          : s,
      ),
    }))
  },

  selectSession: (id) => {
    set({ currentSessionId: id })
  },

  threads: [],
  currentThreadId: null,

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

    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    // 使用传入的完整配置，或构建空壳 fallback
    const config: AgentSessionConfig = sessionConfig ?? {
      workingDirectory: '',
      allowedFiles: [],
      forbiddenFiles: [],
      invariantRules: [],
      upstreamContext: '',
      downstreamContext: '',
      nodeTitle: thread.nodeBound ?? '',
      acceptanceCriteria: [],
    }

    try {
      const result = await window.electronAPI['agent:startSession'](thread.adapterName, config)

      // Record sessionId on thread so stopCurrentSession can find it
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, sessionId: result.sessionId } : t,
        ),
      }))

      const command: AgentCommand = {
        type: 'implement',
        description: content,
        targetNodeId: thread.nodeBound ?? '',
      }

      // Use resolveAndSendCommand if contextRefs exist, otherwise fall back to sendCommand
      if (contextRefs && contextRefs.length > 0) {
        const nodeIds = contextRefs.filter((r) => r.type === 'node').map((r) => r.id)
        await window.electronAPI['agent:resolveAndSendCommand'](
          result.sessionId,
          command,
          contextRefs,
          nodeIds,
        )
      } else {
        await window.electronAPI['agent:sendCommand'](result.sessionId, command)
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
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, title } : t,
      ),
    }))
  },

  deleteThread: (threadId) => {
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

    await get().terminateSession(thread.sessionId)

    // Mark the last streaming agent message as aborted
    const lastStreaming = [...thread.messages].reverse().find((m) => m.role === 'agent' && m.status === 'streaming')
    if (lastStreaming) {
      get().markMessageStatus(threadId, lastStreaming.id, 'aborted')
    }

    get().updateThreadStatus(threadId, 'idle')
  },

  retryMessage: async (threadId, agentMessageId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return

    const agentIdx = thread.messages.findIndex((m) => m.id === agentMessageId)
    if (agentIdx < 0) return

    // Find the preceding user message
    const precedingUser = [...thread.messages.slice(0, agentIdx)].reverse().find((m) => m.role === 'user')
    if (!precedingUser) return

    // Remove the target agent message and everything after it
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: t.messages.slice(0, agentIdx) }
          : t,
      ),
    }))

    // Resend using the original user message content and context
    await get().sendMessage(threadId, precedingUser.content, precedingUser.contextRefs)
  },
}))
