import { create } from 'zustand'
import type { ContextRef } from '@shared/types'

interface AppState {
  activeRightPanel: 'node' | 'agent'
  agentWorkingDirectory: string | null
  pendingContextRef: ContextRef | null
  pendingPrompt: string | null
  setActiveRightPanel: (tab: 'node' | 'agent') => void
  setAgentWorkingDirectory: (dir: string | null) => void
  setPendingContextRef: (ref: ContextRef | null) => void
  setPendingPrompt: (prompt: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  activeRightPanel: 'node',
  agentWorkingDirectory: null,
  pendingContextRef: null,
  pendingPrompt: null,
  setActiveRightPanel: (tab) => set({ activeRightPanel: tab }),
  setAgentWorkingDirectory: (dir) => set({ agentWorkingDirectory: dir }),
  setPendingContextRef: (ref) => set({ pendingContextRef: ref }),
  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
}))
