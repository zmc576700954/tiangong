/**
 * Subagent Store (Phase 5)
 *
 * Holds:
 *  - invocations: live list of SubagentInvocation rows (loaded from IPC + updated via subagent:progress events)
 *  - outputsByInvocation: per-invocation buffered AgentOutput stream
 *  - subagentTypes: AgentTypeDefinition[] from listTypes IPC
 *
 * Updates from two sources:
 *  - useAgentOutputListener pushes tagged outputs (output.invocationId set)
 *  - window.electronAPI.onSubagentProgress pushes status transitions
 */

import { create } from 'zustand'
import type {
  SubagentInvocation,
  SubagentResult,
  AgentTypeDefinition,
  AgentOutput,
} from '@shared/types'

interface SubagentState {
  invocations: SubagentInvocation[]
  outputsByInvocation: Map<string, AgentOutput[]>
  subagentTypes: AgentTypeDefinition[]

  loadInvocations: (parentSessionId: string) => Promise<void>
  loadTypes: () => Promise<void>
  appendOutput: (invocationId: string, output: AgentOutput) => void
  applyProgress: (data: { invocationId: string; status: string; error?: string }) => void
  cancelInvocation: (invocationId: string) => Promise<void>
  getResult: (invocationId: string) => Promise<SubagentResult | null>
  reset: () => void
}

const MAX_OUTPUT_PER_INVOCATION = 500

/** Valid status values for SubagentInvocation — used for runtime validation */
const VALID_SUBAGENT_STATUSES = new Set<string>(['pending', 'queued', 'running', 'completed', 'failed', 'cancelled'])

export const useSubagentStore = create<SubagentState>((set) => ({
  invocations: [],
  outputsByInvocation: new Map(),
  subagentTypes: [],

  loadInvocations: async (parentSessionId) => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    const list = await window.electronAPI['subagent:listInvocations'](parentSessionId)
    set({ invocations: list })
  },

  loadTypes: async () => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    const types = await window.electronAPI['subagent:listTypes']()
    set({ subagentTypes: types })
  },

  appendOutput: (invocationId, output) => {
    set((s) => {
      const next = new Map(s.outputsByInvocation)
      const arr = next.get(invocationId) ?? []
      const updated = [...arr, output]
      // Cap to prevent unbounded growth
      if (updated.length > MAX_OUTPUT_PER_INVOCATION) {
        updated.splice(0, updated.length - MAX_OUTPUT_PER_INVOCATION)
      }
      next.set(invocationId, updated)
      return { outputsByInvocation: next }
    })
  },

  applyProgress: ({ invocationId, status, error }) => {
    // Validate status before applying to prevent invalid states from IPC
    if (!VALID_SUBAGENT_STATUSES.has(status)) {
      console.warn(`[subagentStore] Ignoring invalid subagent status: "${status}" for invocation ${invocationId}`)
      return
    }
    set((s) => {
      const invocations = s.invocations.map((inv) =>
        inv.id === invocationId
          ? { ...inv, status: status as SubagentInvocation['status'], error: error ?? inv.error }
          : inv,
      )
      return { invocations }
    })
  },

  cancelInvocation: async (invocationId) => {
    if (typeof window === 'undefined' || !window.electronAPI) return
    await window.electronAPI['subagent:cancel'](invocationId)
  },

  getResult: async (invocationId) => {
    if (typeof window === 'undefined' || !window.electronAPI) return null
    return window.electronAPI['subagent:getResult'](invocationId)
  },

  reset: () => set({ invocations: [], outputsByInvocation: new Map() }),
}))
