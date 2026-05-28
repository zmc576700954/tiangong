import { create } from 'zustand'
import type { AgentOutput, AgentSessionConfig, AgentCommand } from '@shared/types'

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

  loadAdapters: () => Promise<void>
  startSession: (adapterName: string, config: AgentSessionConfig, nodeId: string) => Promise<string>
  sendCommand: (sessionId: string, command: AgentCommand) => Promise<void>
  terminateSession: (sessionId: string) => Promise<void>
  appendOutput: (sessionId: string, output: AgentOutput) => void
  selectSession: (id: string | null) => void
}

export const useAgentStore = create<AgentState>((set) => ({
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
}))
