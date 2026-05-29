import { create } from 'zustand'
import type { AgentOutput, AgentSessionConfig, AgentCommand, ChatMessage, AgentThread, ContextRef } from '@shared/types'
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
  sendMessage: (threadId: string, content: string, contextRefs?: ContextRef[]) => Promise<void>
  appendChatMessage: (threadId: string, message: ChatMessage) => void
  renameThread: (threadId: string, title: string) => void
  deleteThread: (threadId: string) => void
  selectThread: (id: string | null) => void
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

  sendMessage: async (threadId, content, contextRefs) => {
    const userMessage: ChatMessage = {
      id: generateId('msg'),
      role: 'user',
      content,
      timestamp: Date.now(),
      contextRefs,
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

    const config: AgentSessionConfig = {
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
      const command: AgentCommand = {
        type: 'implement',
        description: content,
        targetNodeId: thread.nodeBound ?? '',
      }
      await window.electronAPI['agent:sendCommand'](result.sessionId, command)
    } catch {
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, status: 'error' as const } : t,
        ),
      }))
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
}))
