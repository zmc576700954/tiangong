import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(useGraphStore.getState as ReturnType<typeof vi.fn>).mockReturnValue({
      batchUpdatePositions,
    })
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
})
