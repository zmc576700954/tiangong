/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect, vi } from 'vitest'
import { GraphSyncService } from '../graph-sync-service'

describe('GraphSyncService', () => {
  test('start begins periodic association scan', () => {
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      scanIntervalMs: 1000
    })
    service.start('g1')
    expect(service.isRunning('g1')).toBe(true)
    service.stop('g1')
  })

  test('stop halts periodic scan', () => {
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      scanIntervalMs: 1000
    })
    service.start('g1')
    service.stop('g1')
    expect(service.isRunning('g1')).toBe(false)
  })

  test('confirmSuggestedEdge clears suggested flag', () => {
    const updateEdge = vi.fn()
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      updateEdge
    })
    service.confirmSuggestedEdge('e1')
    expect(updateEdge).toHaveBeenCalledWith('e1', expect.objectContaining({
      content: expect.objectContaining({ suggested: false })
    }))
  })

  test('rejectSuggestedEdge deletes the edge', () => {
    const deleteEdge = vi.fn()
    const service = new GraphSyncService({
      graphService: {} as any,
      knowledgeAssociator: {} as any,
      pushSuggestedEdges: vi.fn(),
      deleteEdge
    })
    service.rejectSuggestedEdge('e1')
    expect(deleteEdge).toHaveBeenCalledWith('e1')
  })
})
