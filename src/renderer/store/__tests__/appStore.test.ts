import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../appStore'

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeRightPanel: 'node',
      agentWorkingDirectory: null,
    })
  })

  it('should have default state', () => {
    const state = useAppStore.getState()
    expect(state.activeRightPanel).toBe('node')
    expect(state.agentWorkingDirectory).toBeNull()
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
})
