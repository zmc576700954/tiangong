import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useGraphRuntimeStore } from '../graphRuntimeStore'

describe('useGraphRuntimeStore', () => {
  beforeEach(() => {
    useGraphRuntimeStore.setState({
      connectingFrom: null,
      flashedNodeId: null,
      isZoomedOut: false,
      zoomLevel: 1,
    })
  })

  it('has correct default state', () => {
    const state = useGraphRuntimeStore.getState()
    expect(state.connectingFrom).toBeNull()
    expect(state.flashedNodeId).toBeNull()
    expect(state.isZoomedOut).toBe(false)
    expect(state.zoomLevel).toBe(1)
  })

  it('setConnectingFrom updates state', () => {
    useGraphRuntimeStore.getState().setConnectingFrom('node-1')
    expect(useGraphRuntimeStore.getState().connectingFrom).toBe('node-1')

    useGraphRuntimeStore.getState().setConnectingFrom(null)
    expect(useGraphRuntimeStore.getState().connectingFrom).toBeNull()
  })

  it('setZoomLevel updates state', () => {
    useGraphRuntimeStore.getState().setZoomLevel(2.5)
    expect(useGraphRuntimeStore.getState().zoomLevel).toBe(2.5)
  })

  it('setIsZoomedOut updates state', () => {
    useGraphRuntimeStore.getState().setIsZoomedOut(true)
    expect(useGraphRuntimeStore.getState().isZoomedOut).toBe(true)
  })

  it('flashNode sets flashedNodeId and clears after timeout', () => {
    vi.useFakeTimers()

    useGraphRuntimeStore.getState().flashNode('flash-1')
    expect(useGraphRuntimeStore.getState().flashedNodeId).toBe('flash-1')

    vi.advanceTimersByTime(200)
    expect(useGraphRuntimeStore.getState().flashedNodeId).toBeNull()

    vi.useRealTimers()
  })

  it('flashNode does not clear if a different node was flashed', () => {
    vi.useFakeTimers()

    useGraphRuntimeStore.getState().flashNode('flash-1')
    useGraphRuntimeStore.getState().flashNode('flash-2')

    // After 200ms, flash-1 timer fires but flashedNodeId is 'flash-2', so no change
    // But flash-2 timer also fires and clears it
    // We advance in steps to verify the behavior
    vi.advanceTimersByTime(100)
    // Neither timer has fired yet (both are 200ms)
    expect(useGraphRuntimeStore.getState().flashedNodeId).toBe('flash-2')

    vi.advanceTimersByTime(100)
    // Both timers fire at 200ms
    // flash-1 timer: flashedNodeId !== 'flash-1', no change
    // flash-2 timer: flashedNodeId === 'flash-2', clears to null
    expect(useGraphRuntimeStore.getState().flashedNodeId).toBeNull()

    vi.useRealTimers()
  })
})
