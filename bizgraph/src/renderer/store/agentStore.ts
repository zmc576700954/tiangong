import { create } from 'zustand'
import type { AgentOutput, AgentSessionConfig, AgentCommand } from '@shared/types'

interface AgentSessionState {
  id: string
  adapterName: string
  nodeId: string
  status: 'running' | 'completed' | 'error'
  outputs: AgentOutput[]
  startTime: number
  endTime?: number
}

interface AgentState {
  // 适配器列表
  adapters: { name: string; version: string; installed: boolean }[]
  // 会话
  sessions: AgentSessionState[]
  // 当前选中会话
  currentSessionId: string | null

  // 加载适配器
  loadAdapters: () => Promise<void>

  // 启动会话
  startSession: (
    adapterName: string,
    config: AgentSessionConfig,
    nodeId: string,
  ) => Promise<string>

  // 发送指令
  sendCommand: (sessionId: string, command: AgentCommand) => Promise<void>

  // 终止会话
  terminateSession: (sessionId: string) => Promise<void>

  // 接收输出
  appendOutput: (sessionId: string, output: AgentOutput) => void

  // 选择会话
  selectSession: (id: string | null) => void
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
      adapterName,
      nodeId,
      status: 'running',
      outputs: [],
      startTime: Date.now(),
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
              outputs: [...s.outputs, output],
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