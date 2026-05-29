import { create } from 'zustand'

interface AppState {
  activeRightPanel: 'node' | 'agent'
  agentWorkingDirectory: string | null
  setActiveRightPanel: (tab: 'node' | 'agent') => void
  setAgentWorkingDirectory: (dir: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeRightPanel: 'node',
  agentWorkingDirectory: null,
  setActiveRightPanel: (tab) => set({ activeRightPanel: tab }),
  setAgentWorkingDirectory: (dir) => set({ agentWorkingDirectory: dir }),
}))
