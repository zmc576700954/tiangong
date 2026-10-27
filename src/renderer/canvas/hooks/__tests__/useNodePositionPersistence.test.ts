// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useNodePositionPersistence } from '../useNodePositionPersistence'
import { useGraphStore } from '../../../store/graphStore'
import type { NodeChange } from '@xyflow/react'

// Mock useGraphStore
vi.mock('../../../store/graphStore', () => ({
  useGraphStore: {
    getState: vi.fn(),
  },
}))

describe('useNodePositionPersistence', () => {
  const batchUpdatePositions = vi.fn().mockResolvedValue(undefined)
  /** 只改 store、不落库的位置更新（FIX-11） */
  const applyLocalPositions = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(useGraphStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      batchUpdatePositions,
      applyLocalPositions,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes pending position updates before graph switch', async () => {
    // 1. Render with graphId "A"
    const { rerender, result } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    // 2. Simulate a node drag-end position change
    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    // At this point, batchUpdatePositions should NOT have been called yet
    // because the 300ms timer hasn't fired
    expect(batchUpdatePositions).not.toHaveBeenCalled()

    // 3. Change graphId to "B" before the 300ms timer fires
    rerender({ graphId: 'B' })

    // 4. Verify batchUpdatePositions was called with the pending update
    expect(batchUpdatePositions).toHaveBeenCalledTimes(1)
    expect(batchUpdatePositions).toHaveBeenCalledWith([
      { id: 'node-1', x: 100, y: 200 },
    ])
  })

  it('flushes pending position updates on unmount', () => {
    const { result, unmount } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    // Trigger a position change
    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    expect(batchUpdatePositions).not.toHaveBeenCalled()

    // Unmount should flush pending updates
    unmount()

    expect(batchUpdatePositions).toHaveBeenCalledTimes(1)
    expect(batchUpdatePositions).toHaveBeenCalledWith([
      { id: 'node-1', x: 100, y: 200 },
    ])
  })

  it('flushes correctly on rapid graph switches', () => {
    const { rerender, result } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    // First position change on graph A
    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    // Switch to B - should flush node-1
    rerender({ graphId: 'B' })

    expect(batchUpdatePositions).toHaveBeenCalledTimes(1)
    expect(batchUpdatePositions).toHaveBeenNthCalledWith(1, [
      { id: 'node-1', x: 100, y: 200 },
    ])

    // Second position change on graph B
    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-2',
        position: { x: 300, y: 400 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    // Switch to C - should flush node-2
    rerender({ graphId: 'C' })

    expect(batchUpdatePositions).toHaveBeenCalledTimes(2)
    expect(batchUpdatePositions).toHaveBeenNthCalledWith(2, [
      { id: 'node-2', x: 300, y: 400 },
    ])
  })

  it('does not throw when batchUpdatePositions rejects', () => {
    const rejectFn = vi.fn().mockRejectedValue(new Error('DB error'))
    ;(useGraphStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      batchUpdatePositions: rejectFn,
      applyLocalPositions,
    })

    const { rerender, result } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    // Trigger a position change
    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    // Switch graph should not throw even if batchUpdatePositions rejects
    expect(() => rerender({ graphId: 'B' })).not.toThrow()
    expect(rejectFn).toHaveBeenCalledTimes(1)
    expect(rejectFn).toHaveBeenCalledWith([
      { id: 'node-1', x: 100, y: 200 },
    ])
  })

  it('updates the store immediately when a drag ends, without waiting for the debounce', () => {
    // 松手那一下：store 必须**立刻**跟上画布。
    // flowNodes 的缓存键一变（被拖节点的 zIndex 变化）就会整条重建，
    // 重建时带的是 store 里的位置 —— store 落后 300ms 就会弹回拖拽前的位置。
    const { result } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    expect(applyLocalPositions).toHaveBeenCalledWith([{ id: 'node-1', x: 100, y: 200 }])
    // 落库仍然防抖 —— store 跟上了，DB 还没写
    expect(batchUpdatePositions).not.toHaveBeenCalled()
  })

  it('does not touch the store while the node is still being dragged', () => {
    // 拖拽过程中画布上的位置由 xyflow 管，不许写 store
    const { result } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: true,
      } as unknown as NodeChange,
    ])

    expect(applyLocalPositions).not.toHaveBeenCalled()
  })

  it('does not touch the store for a node whose position was taken over by reparent', () => {
    // 位置被重挂接管的节点：连 store 都不许动 —— 它的位置由主进程的 movedPositions 决定
    const { result } = renderHook(
      ({ graphId }: { graphId: string }) => useNodePositionPersistence(graphId),
      { initialProps: { graphId: 'A' } }
    )

    result.current.suppressPositions(['node-1'])
    result.current.handleNodesChange([
      {
        type: 'position',
        id: 'node-1',
        position: { x: 100, y: 200 },
        dragging: false,
      } as unknown as NodeChange,
    ])

    expect(applyLocalPositions).not.toHaveBeenCalled()
    expect(batchUpdatePositions).not.toHaveBeenCalled()
  })
})
