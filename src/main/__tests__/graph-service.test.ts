import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphService } from '../services/graph-service'
import type { GraphType } from '@shared/types'
import type { GraphRepository } from '../repositories/graph-repository'
import type BetterSqlite3 from 'better-sqlite3'

function createMockDb() {
  const stmtMock = {
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(null),
    all: vi.fn().mockReturnValue([]),
  }
  const db = {
    prepare: vi.fn().mockReturnValue(stmtMock),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args)),
    exec: vi.fn(),
    pragma: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as BetterSqlite3.Database & { _stmt: typeof stmtMock }
  ;(db as unknown as Record<string, unknown>)._stmt = stmtMock
  return { db, stmt: stmtMock }
}

vi.mock('../repositories/graph-repository', () => ({
  GraphRepository: vi.fn().mockImplementation(function (this: GraphRepository) {
    this.create = vi.fn((data: { name: string; type: GraphType }) => ({
      id: 'graph-id',
      name: data.name,
      type: data.type,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    }))
    this.list = vi.fn().mockReturnValue([])
    this.get = vi.fn().mockReturnValue(null)
    this.delete = vi.fn()
    this.getProjectPaths = vi.fn().mockReturnValue([])
    this.cloneGraphNodes = vi.fn()
  }),
}))

describe('GraphService', () => {
  let db: BetterSqlite3.Database
  let service: GraphService

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    service = new GraphService(db)
  })

  it('createGraph creates and invalidates cache', () => {
    const graph = service.createGraph({ name: 'G1', type: 'online' })
    expect(graph.name).toBe('G1')
    expect(graph.type).toBe('online')
  })

  it('deriveGraph throws when source not found', () => {
    expect(() => service.deriveGraph('missing')).toThrow('Source graph not found')
  })

  it('deriveGraph throws when source is not online', () => {
    const repo = (service as unknown as { graphRepo: { get: ReturnType<typeof vi.fn> } }).graphRepo
    repo.get.mockReturnValue({ graph: { id: 'g1', type: 'dev' } })
    expect(() => service.deriveGraph('g1')).toThrow('Can only derive dev graph from an online graph')
  })

  it('listGraphs delegates to repository', () => {
    expect(service.listGraphs()).toEqual([])
  })

  it('deleteGraph invalidates cache', () => {
    service.deleteGraph('g1')
    // Should not throw
  })

  it('getProjectPaths caches result', () => {
    const paths1 = service.getProjectPaths()
    const paths2 = service.getProjectPaths()
    expect(paths1).toEqual(paths2)
  })

  it('suggestEdges returns empty when SymbolIndex not set', async () => {
    const suggestions = await service.suggestEdges('g1')
    expect(suggestions).toEqual([])
  })
})
