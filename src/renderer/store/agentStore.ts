/**
 * Backward-compatible re-export layer for the split agent sub-stores.
 *
 * All components that import useAgentStore continue to work unchanged.
 * Each method delegates to the appropriate sub-store, and state changes
 * in sub-stores are synced back so that getState() reflects the truth.
 *
 * TODO: migrate components to use sub-stores directly
 */

import { create } from 'zustand'
import type { AgentOutput, AgentSessionConfig, AgentCommand, ChatMessage, AgentThread, ContextRef, MessageStatus, MessageError, ToolCallBlock, AdapterPreferences, AdapterFallbackAttempt, AdapterMarketplaceItem } from '@shared/types'
import type { AdapterState } from './adapterStore'
import { useAgentOutputStore } from './agentOutputStore'
import { useAdapterStore } from './adapterStore'
import { useThreadStore } from './threadStore'
import { useMessageStore } from './messageStore'
import { useSessionStore } from './sessionStore'

interface AgentState {
  adapters: { name: string; version: string; installed: boolean }[]
  threads: AgentThread[]
  currentThreadId: string | null
  /** 适配器偏好配置 */
  adapterPreferences: AdapterPreferences
  /** 最近一次 startSession 的回退历史（用于 UI 展示） */
  lastFallbackHistory: AdapterFallbackAttempt[]
  /** 适配器市场数据（含安装状态和安装方式） */
  marketplaceItems: AdapterMarketplaceItem[]
  /** 是否需要打开设置面板（跨面板通信标志） */
  openSettingsPanel: boolean

  loadAdapters: () => Promise<void>
  loadAdapterPreferences: () => Promise<void>
  setAdapterPreferences: (prefs: AdapterPreferences) => Promise<void>
  loadMarketplaceItems: () => Promise<void>
  setOpenSettingsPanel: (open: boolean) => void
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
  deleteThread: (threadId: string) => Promise<void>
  selectThread: (id: string | null) => void
  updateThreadStatus: (threadId: string, status: 'idle' | 'running' | 'error' | 'reviewed') => void
  markMessageStatus: (threadId: string, messageId: string, status: MessageStatus, error?: MessageError) => void
  stopCurrentSession: (threadId: string) => Promise<void>
  retryMessage: (threadId: string, agentMessageId: string) => Promise<void>
  findThreadBySessionId: (sessionId: string) => AgentThread | undefined
  /** 按 nodeBound 查找 thread（避免 threads.find 遍历） */
  getThreadByNodeId: (nodeId: string) => AgentThread | undefined

  // 持久化相关
  loadThreads: (filters?: { nodeId?: string; graphId?: string }) => Promise<void>
  loadMessages: (threadId: string) => Promise<void>
  persistMessage: (threadId: string, message: ChatMessage) => Promise<void>
  persistThreadMessages: (threadId: string) => Promise<void>
  hydrateOnStart: () => Promise<void>
  listenForStatusChanges: () => () => void
}

// Subscribe to sub-store changes and sync into agentStore's own state
// so that getState() always reflects the truth from sub-stores.
// Uses _originalSetState (assigned below) to avoid re-forwarding to sub-stores.
// eslint-disable-next-line prefer-const
let _originalSetState: typeof useAgentStore.setState

let _adapterRafId: number | null = null
let _threadRafId: number | null = null

function syncFromSubStores() {
  _originalSetState({
    adapters: useAdapterStore.getState().adapters,
    adapterPreferences: useAdapterStore.getState().adapterPreferences,
    lastFallbackHistory: useAdapterStore.getState().lastFallbackHistory,
    marketplaceItems: useAdapterStore.getState().marketplaceItems,
    openSettingsPanel: useAdapterStore.getState().openSettingsPanel,
    threads: useThreadStore.getState().threads,
    currentThreadId: useThreadStore.getState().currentThreadId,
  })

  useAdapterStore.subscribe((state) => {
    if (_adapterRafId !== null) cancelAnimationFrame(_adapterRafId)
    _adapterRafId = requestAnimationFrame(() => {
      _originalSetState({
        adapters: state.adapters,
        adapterPreferences: state.adapterPreferences,
        lastFallbackHistory: state.lastFallbackHistory,
        marketplaceItems: state.marketplaceItems,
        openSettingsPanel: state.openSettingsPanel,
      })
      _adapterRafId = null
    })
  })

  useThreadStore.subscribe((state) => {
    if (_threadRafId !== null) cancelAnimationFrame(_threadRafId)
    _threadRafId = requestAnimationFrame(() => {
      _originalSetState({
        threads: state.threads,
        currentThreadId: state.currentThreadId,
      })
      _threadRafId = null
    })
  })
}

export const useAgentStore = create<AgentState>(() => ({
  adapters: [],
  threads: [],
  currentThreadId: null,
  adapterPreferences: { defaultAdapter: 'claude-code', fallbackOrder: ['codex', 'opencode', 'cline', 'kilo-code', 'kimi-code', 'qwen-code', 'codebuddy', 'qoder', 'cursor', 'mcp'] },
  lastFallbackHistory: [],
  marketplaceItems: [],
  openSettingsPanel: false,

  loadAdapters: async () => {
    await useAdapterStore.getState().loadAdapters()
  },

  loadAdapterPreferences: async () => {
    await useAdapterStore.getState().loadAdapterPreferences()
  },

  setAdapterPreferences: async (prefs) => {
    await useAdapterStore.getState().setAdapterPreferences(prefs)
  },

  loadMarketplaceItems: async () => {
    await useAdapterStore.getState().loadMarketplaceItems()
  },

  setOpenSettingsPanel: (open) => {
    useAdapterStore.getState().setOpenSettingsPanel(open)
  },

  sendCommand: async (sessionId, command) => {
    await window.electronAPI['agent:sendCommand'](sessionId, command)
  },

  appendOutput: (threadId, output) => {
    useAgentOutputStore.getState().appendOutput(threadId, output)
    if (output.type === 'error') {
      useThreadStore.setState((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, status: 'error' as const } : t,
        ),
      }))
    }
  },

  appendToStreamingMessage: (threadId, messageId, content) => {
    useMessageStore.getState().appendToStreamingMessage(threadId, messageId, content)
  },

  clearThreadOutputs: (threadId) => {
    useAgentOutputStore.getState().clearThreadOutputs(threadId)
  },

  trimInactiveThreadOutputs: (activeThreadId) => {
    useAgentOutputStore.getState().trimInactiveThreadOutputs(activeThreadId)
  },

  appendToolCall: (threadId, messageId, toolCall) => {
    useMessageStore.getState().appendToolCall(threadId, messageId, toolCall)
  },

  updateToolCallAccepted: (threadId, messageIndex, toolCallIndex, accepted) => {
    useMessageStore.getState().updateToolCallAccepted(threadId, messageIndex, toolCallIndex, accepted)
  },

  updateAllToolCallsAccepted: (threadId, accepted) => {
    useMessageStore.getState().updateAllToolCallsAccepted(threadId, accepted)
  },

  getOutputs: (threadId) => {
    return useAgentOutputStore.getState().getOutputs(threadId)
  },

  createThread: (adapterName, nodeBound) => {
    return useThreadStore.getState().createThread(adapterName, nodeBound)
  },

  sendMessage: (threadId, content, contextRefs, sessionConfig) => {
    return useSessionStore.getState().sendMessage(threadId, content, contextRefs, sessionConfig)
  },

  appendChatMessage: (threadId, message) => {
    useThreadStore.getState().appendChatMessage(threadId, message)
  },

  renameThread: (threadId, title) => {
    useThreadStore.getState().renameThread(threadId, title)
  },

  deleteThread: (threadId) => {
    return useThreadStore.getState().deleteThread(threadId)
  },

  selectThread: (id) => {
    useThreadStore.getState().selectThread(id)
  },

  updateThreadStatus: (threadId, status) => {
    useThreadStore.getState().updateThreadStatus(threadId, status)
  },

  markMessageStatus: (threadId, messageId, status, error) => {
    useMessageStore.getState().markMessageStatus(threadId, messageId, status, error)
  },

  stopCurrentSession: (threadId) => {
    return useSessionStore.getState().stopCurrentSession(threadId)
  },

  retryMessage: (threadId, agentMessageId) => {
    return useMessageStore.getState().retryMessage(threadId, agentMessageId)
  },

  findThreadBySessionId: (sessionId) => {
    return useThreadStore.getState().findThreadBySessionId(sessionId)
  },

  getThreadByNodeId: (nodeId) => {
    return useThreadStore.getState().getThreadByNodeId(nodeId)
  },

  loadThreads: async (filters) => {
    await useThreadStore.getState().loadThreads(filters)
  },

  loadMessages: async (threadId) => {
    await useThreadStore.getState().loadMessages(threadId)
  },

  persistMessage: async (threadId, message) => {
    await useThreadStore.getState().persistMessage(threadId, message)
  },

  persistThreadMessages: async (threadId) => {
    await useThreadStore.getState().persistThreadMessages(threadId)
  },

  hydrateOnStart: async () => {
    try {
      const threads = await window.electronAPI['thread:list']()
      if (threads.length > 0) {
        useThreadStore.setState({ threads, currentThreadId: threads[0].id })
      }
    } catch (err) {
      console.error('[agentStore] Failed to hydrate threads:', err)
    }
    // 加载适配器偏好
    useAdapterStore.getState().loadAdapterPreferences()
    // 启动时主动检测适配器状态
    useAdapterStore.getState().loadAdapters()
    useAdapterStore.getState().loadMarketplaceItems()
  },

  listenForStatusChanges: () => {
    return useSessionStore.getState().listenForStatusChanges()
  },
}))

// Override setState to forward state slices to sub-stores when tests or
// legacy code sets state directly on useAgentStore.
_originalSetState = useAgentStore.setState.bind(useAgentStore) as typeof useAgentStore.setState
useAgentStore.setState = function overrideSetState(
  partial:
    | Partial<AgentState>
    | ((state: AgentState) => Partial<AgentState>),
  replace?: boolean,
) {
  // Apply to agentStore first so the subscriber sync doesn't re-apply
  _originalSetState(partial as Partial<AgentState>, replace as false | undefined)

  // Then forward relevant slices to sub-stores
  const resolved = typeof partial === 'function'
    ? (partial as (state: AgentState) => Partial<AgentState>)(useAgentStore.getState())
    : partial

  if (resolved.threads !== undefined || resolved.currentThreadId !== undefined) {
    const threadSlice: Partial<AgentState> = {}
    if (resolved.threads !== undefined) threadSlice.threads = resolved.threads
    if (resolved.currentThreadId !== undefined) threadSlice.currentThreadId = resolved.currentThreadId
    // Only set the data fields, not the methods
    useThreadStore.setState({ threads: threadSlice.threads!, currentThreadId: threadSlice.currentThreadId } as Record<string, unknown>, false)
  }

  if (
    resolved.adapters !== undefined ||
    resolved.adapterPreferences !== undefined ||
    resolved.lastFallbackHistory !== undefined ||
    resolved.marketplaceItems !== undefined ||
    resolved.openSettingsPanel !== undefined
  ) {
    const adapterSlice: Record<string, unknown> = {}
    if (resolved.adapters !== undefined) adapterSlice.adapters = resolved.adapters
    if (resolved.adapterPreferences !== undefined) adapterSlice.adapterPreferences = resolved.adapterPreferences
    if (resolved.lastFallbackHistory !== undefined) adapterSlice.lastFallbackHistory = resolved.lastFallbackHistory
    if (resolved.marketplaceItems !== undefined) adapterSlice.marketplaceItems = resolved.marketplaceItems
    if (resolved.openSettingsPanel !== undefined) adapterSlice.openSettingsPanel = resolved.openSettingsPanel
    useAdapterStore.setState(adapterSlice as Partial<AdapterState>, false)
  }
} as typeof useAgentStore.setState

// Activate the sync bridge so getState() always reflects sub-store truth
syncFromSubStores()

// Re-export sub-stores for direct import by new code
export { useAdapterStore } from './adapterStore'
export { useThreadStore } from './threadStore'
export { useMessageStore } from './messageStore'
export { useSessionStore } from './sessionStore'
