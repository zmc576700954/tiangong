import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../appStore'
import type { ContextRef } from '@shared/types'

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeRightPanel: 'node',
      agentWorkingDirectory: null,
      pendingContextRef: null,
    })
  })

  it('should have default state', () => {
    const state = useAppStore.getState()
    expect(state.activeRightPanel).toBe('node')
    expect(state.agentWorkingDirectory).toBeNull()
    expect(state.pendingContextRef).toBeNull()
  })

  it('setActiveRightPanel should switch tab', () => {
    useAppStore.getState().setActiveRightPanel('agent')
    expect(useAppStore.getState().activeRightPanel).toBe('agent')
  })

  it('setAgentWorkingDirectory should set path', () => {
    useAppStore.getState().setAgentWorkingDirectory('/project/src/auth')
    expect(useAppStore.getState().agentWorkingDirectory).toBe('/project/src/auth')
  })

  it('setAgentWorkingDirectory null should clear path', () => {
    useAppStore.getState().setAgentWorkingDirectory('/some/path')
    useAppStore.getState().setAgentWorkingDirectory(null)
    expect(useAppStore.getState().agentWorkingDirectory).toBeNull()
  })

  it('setPendingContextRef should set ref', () => {
    const ref: ContextRef = { type: 'file', id: '/path/to/file.ts', label: 'file.ts' }
    useAppStore.getState().setPendingContextRef(ref)
    expect(useAppStore.getState().pendingContextRef).toEqual(ref)
  })

  it('setPendingContextRef null should clear ref', () => {
    useAppStore.getState().setPendingContextRef({ type: 'file', id: '/x', label: 'x' })
    useAppStore.getState().setPendingContextRef(null)
    expect(useAppStore.getState().pendingContextRef).toBeNull()
  })
})
