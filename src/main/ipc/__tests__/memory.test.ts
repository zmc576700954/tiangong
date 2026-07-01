import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock memory store
const mockSearch = vi.fn().mockResolvedValue([])
const mockGetRecent = vi.fn().mockResolvedValue([])
const mockGetByNode = vi.fn().mockResolvedValue([])
const mockGetBySession = vi.fn().mockResolvedValue([])
const mockGetStats = vi.fn().mockResolvedValue({})
const mockGetCrossAdapter = vi.fn().mockResolvedValue([])
const mockDeleteBySessionScoped = vi.fn().mockResolvedValue(0)
const mockPruneStale = vi.fn().mockResolvedValue(0)
const mockGetEvolutionChain = vi.fn().mockResolvedValue([])
const mockBackfillEmbeddings = vi.fn().mockResolvedValue(0)
const mockPruneWithDecay = vi.fn().mockResolvedValue(0)

vi.mock('../../memory/memory-store', () => ({
  getMemoryStore: () => ({
    search: mockSearch,
    getRecent: mockGetRecent,
    getByNode: mockGetByNode,
    getBySession: mockGetBySession,
    getStats: mockGetStats,
    getCrossAdapter: mockGetCrossAdapter,
    deleteBySessionScoped: mockDeleteBySessionScoped,
    pruneStale: mockPruneStale,
    getEvolutionChain: mockGetEvolutionChain,
    backfillEmbeddings: mockBackfillEmbeddings,
    pruneWithDecay: mockPruneWithDecay,
  }),
}))

vi.mock('../../memory/waterline-sync', () => ({
  getWaterlineSync: () => ({
    restore: vi.fn(),
  }),
}))

import { registerMemoryHandlers } from '../memory'
import type { TypedHandle } from '../utils'

describe('registerMemoryHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    const typedHandle = ((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = handler
    }) as TypedHandle
    registerMemoryHandlers(typedHandle)
  })

  it('registers all handlers', () => {
    expect(handlers['memory:search']).toBeDefined()
    expect(handlers['memory:getRecent']).toBeDefined()
    expect(handlers['memory:getByNode']).toBeDefined()
    expect(handlers['memory:getBySession']).toBeDefined()
    expect(handlers['memory:getStats']).toBeDefined()
    expect(handlers['memory:getCrossAdapter']).toBeDefined()
    expect(handlers['memory:delete']).toBeDefined()
    expect(handlers['memory:prune']).toBeDefined()
    expect(handlers['memory:getEvolutionChain']).toBeDefined()
    expect(handlers['memory:pruneWithDecay']).toBeDefined()
  })

  describe('memory:search', () => {
    it('calls store.search with valid query', async () => {
      await handlers['memory:search']({}, 'authentication login')
      expect(mockSearch).toHaveBeenCalledWith('authentication login', expect.objectContaining({
        limit: expect.any(Number),
      }))
    })

    it('rejects empty query', async () => {
      await expect(handlers['memory:search']({}, '')).rejects.toThrow()
    })

    it('rejects query with only whitespace', async () => {
      await expect(handlers['memory:search']({}, '   ')).rejects.toThrow()
    })

    it('rejects query that is too short', async () => {
      await expect(handlers['memory:search']({}, 'a')).rejects.toThrow()
    })

    it('rejects non-string query', async () => {
      await expect(handlers['memory:search']({}, 123)).rejects.toThrow()
    })

    it('applies kind filter', async () => {
      await handlers['memory:search']({}, 'test query', { kind: 'fix' })
      expect(mockSearch).toHaveBeenCalledWith('test query', expect.objectContaining({
        kind: 'fix',
      }))
    })

    it('rejects invalid kind', async () => {
      await expect(handlers['memory:search']({}, 'test', { kind: 'invalid' })).rejects.toThrow()
    })

    it('applies limit', async () => {
      await handlers['memory:search']({}, 'test query', { limit: 10 })
      expect(mockSearch).toHaveBeenCalledWith('test query', expect.objectContaining({
        limit: 10,
      }))
    })

    it('caps limit at 500', async () => {
      await handlers['memory:search']({}, 'test query', { limit: 999 })
      expect(mockSearch).toHaveBeenCalledWith('test query', expect.objectContaining({
        limit: 500,
      }))
    })
  })

  describe('memory:getRecent', () => {
    it('calls store.getRecent', async () => {
      await handlers['memory:getRecent']({}, { projectId: 'p1' })
      expect(mockGetRecent).toHaveBeenCalled()
    })
  })

  describe('memory:getByNode', () => {
    it('calls store.getByNode', async () => {
      await handlers['memory:getByNode']({}, 'node-1')
      expect(mockGetByNode).toHaveBeenCalledWith('node-1', expect.any(Number))
    })
  })

  describe('memory:getBySession', () => {
    it('calls store.getBySession', async () => {
      await handlers['memory:getBySession']({}, 'sess-1')
      expect(mockGetBySession).toHaveBeenCalledWith('sess-1', expect.any(Number))
    })
  })

  describe('memory:getStats', () => {
    it('calls store.getStats', async () => {
      await handlers['memory:getStats']({}, 'p1')
      expect(mockGetStats).toHaveBeenCalledWith('p1')
    })
  })

  describe('memory:getCrossAdapter', () => {
    it('calls store.getCrossAdapter', async () => {
      await handlers['memory:getCrossAdapter']({}, 'p1', 'claude-code')
      expect(mockGetCrossAdapter).toHaveBeenCalledWith('p1', 'claude-code', expect.any(Number))
    })
  })

  describe('memory:delete', () => {
    it('calls store.deleteBySessionScoped', async () => {
      await handlers['memory:delete']({}, 'sess-1', 'p1')
      expect(mockDeleteBySessionScoped).toHaveBeenCalledWith('sess-1', 'p1')
    })

    it('rejects empty sessionId', async () => {
      await expect(handlers['memory:delete']({}, '', 'p1')).rejects.toThrow()
    })

    it('rejects empty projectId', async () => {
      await expect(handlers['memory:delete']({}, 'sess-1', '')).rejects.toThrow()
    })
  })

  describe('memory:prune', () => {
    it('calls store.pruneStale with default 90 days', async () => {
      await handlers['memory:prune']({})
      expect(mockPruneStale).toHaveBeenCalledWith(90)
    })

    it('uses custom days threshold', async () => {
      await handlers['memory:prune']({}, 30)
      expect(mockPruneStale).toHaveBeenCalledWith(30)
    })

    it('rejects days < 1', async () => {
      await expect(handlers['memory:prune']({}, 0)).rejects.toThrow()
    })

    it('rejects days > 3650', async () => {
      await expect(handlers['memory:prune']({}, 4000)).rejects.toThrow()
    })

    it('rejects non-finite days', async () => {
      await expect(handlers['memory:prune']({}, NaN)).rejects.toThrow()
    })
  })

  describe('memory:pruneWithDecay', () => {
    it('calls store.pruneWithDecay', async () => {
      await handlers['memory:pruneWithDecay']({}, 'p1')
      expect(mockPruneWithDecay).toHaveBeenCalledWith('p1', {})
    })

    it('validates baseHalfLife range', async () => {
      await expect(handlers['memory:pruneWithDecay']({}, 'p1', { baseHalfLife: 0 })).rejects.toThrow()
    })

    it('validates minConfidence range', async () => {
      await expect(handlers['memory:pruneWithDecay']({}, 'p1', { minConfidence: 2 })).rejects.toThrow()
    })

    it('validates maxItems range', async () => {
      await expect(handlers['memory:pruneWithDecay']({}, 'p1', { maxItems: 0 })).rejects.toThrow()
    })
  })
})
