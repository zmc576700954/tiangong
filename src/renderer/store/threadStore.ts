import { create } from 'zustand'
import type { AgentThread, ChatMessage } from '@shared/types'
import { generateId } from '../lib/utils'
import { useAgentOutputStore } from './agentOutputStore'

export interface ThreadState {
  threads: AgentThread[]
  currentThreadId: string | null
  nodeThreadMap: Map<string, AgentThread>

  createThread: (adapterName: string, nodeBound?: string) => string
  deleteThread: (threadId: string) => Promise<void>
  selectThread: (id: string | null) => void
  renameThread: (threadId: string, title: string) => void
  loadThreads: (filters?: { nodeId?: string; graphId?: string }) => Promise<void>
  updateThreadStatus: (threadId: string, status: 'idle' | 'running' | 'error' | 'reviewed') => void
  findThreadBySessionId: (sessionId: string) => AgentThread | undefined
  getThreadByNodeId: (nodeId: string) => AgentThread | undefined
  loadMessages: (threadId: string) => Promise<void>
  appendChatMessage: (threadId: string, message: ChatMessage) => void
  /** Persist a single message to DB */
  persistMessage: (threadId: string, message: ChatMessage) => Promise<void>
  /** Persist all messages of a thread to DB */
  persistThreadMessages: (threadId: string) => Promise<void>
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  currentThreadId: null,
  nodeThreadMap: new Map<string, AgentThread>(),

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
    set((state) => {
      const newNodeThreadMap = nodeBound
        ? new Map(state.nodeThreadMap).set(nodeBound, thread)
        : state.nodeThreadMap
      return {
        threads: [...state.threads, thread],
        currentThreadId: id,
        nodeThreadMap: newNodeThreadMap,
      }
    })
    // Persist to DB — use returned DB ID if available
    window.electronAPI['thread:create']({ adapterName, nodeId: nodeBound }).then((dbThread) => {
      if (dbThread?.id && dbThread.id !== id) {
        // Replace frontend ID with DB ID for consistency
        set((state) => {
          const updatedThread = state.threads.find((t) => t.id === id)
          const newNodeThreadMap = nodeBound && updatedThread
            ? new Map(state.nodeThreadMap).set(nodeBound, { ...updatedThread, id: dbThread.id })
            : state.nodeThreadMap
          return {
            threads: state.threads.map((t) =>
              t.id === id ? { ...t, id: dbThread.id } : t
            ),
            currentThreadId: state.currentThreadId === id ? dbThread.id : state.currentThreadId,
            nodeThreadMap: newNodeThreadMap,
          }
        })
      }
    }).catch((err) => {
      console.error('[threadStore] Failed to persist new thread:', err)
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === id ? { ...t, status: 'error' as const } : t
        ),
      }))
    })
    return id
  },

  deleteThread: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    try {
      await window.electronAPI['thread:delete'](threadId)
    } catch (err) {
      console.error('[threadStore] Failed to delete thread from DB:', err)
      // Restore thread in UI since DB deletion failed
      if (thread) {
        set((state) => ({
          threads: [...state.threads, thread],
          nodeThreadMap: thread.nodeBound
            ? new Map(state.nodeThreadMap).set(thread.nodeBound, thread)
            : state.nodeThreadMap,
        }))
      }
      return
    }
    set((state) => {
      const newNodeThreadMap = new Map(state.nodeThreadMap)
      if (thread?.nodeBound) newNodeThreadMap.delete(thread.nodeBound)
      return {
        threads: state.threads.filter((t) => t.id !== threadId),
        currentThreadId:
          state.currentThreadId === threadId
            ? state.threads.find((t) => t.id !== threadId)?.id ?? null
            : state.currentThreadId,
        nodeThreadMap: newNodeThreadMap,
      }
    })
  },

  selectThread: (id) => {
    set({ currentThreadId: id })
    if (id) useAgentOutputStore.getState().trimInactiveThreadOutputs(id)
  },

  renameThread: (threadId, title) => {
    const prevTitle = get().threads.find((t) => t.id === threadId)?.title
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, title } : t,
      ),
    }))
    window.electronAPI['thread:update'](threadId, { title }).catch((err) => {
      console.error('[threadStore] Failed to persist thread rename:', err)
      if (prevTitle) {
        set((state) => ({
          threads: state.threads.map((t) =>
            t.id === threadId ? { ...t, title: prevTitle } : t,
          ),
        }))
      }
    })
  },

  loadThreads: async (filters) => {
    const threads = await window.electronAPI['thread:list'](filters)
    const nodeThreadMap = new Map<string, AgentThread>()
    for (const t of threads) {
      if (t.nodeBound) nodeThreadMap.set(t.nodeBound, t)
    }
    set({ threads, nodeThreadMap })
  },

  updateThreadStatus: (threadId, status) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, status } : t,
      ),
    }))
  },

  findThreadBySessionId: (sessionId) => {
    return get().threads.find((t) => t.sessionId === sessionId)
  },

  getThreadByNodeId: (nodeId) => {
    return get().nodeThreadMap.get(nodeId)
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

  appendChatMessage: (threadId, message) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, messages: [...t.messages, message] }
          : t,
      ),
    }))
  },

  persistMessage: async (threadId, message) => {
    try {
      await window.electronAPI['message:save'](threadId, message)
    } catch (err) {
      console.error('[threadStore] Failed to persist message:', err)
    }
  },

  persistThreadMessages: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return
    try {
      await window.electronAPI['message:saveBatch'](threadId, thread.messages)
    } catch (err) {
      console.error('[threadStore] Failed to persist thread messages:', err)
    }
  },
}))
