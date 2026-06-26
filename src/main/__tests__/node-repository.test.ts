import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NodeRepository } from '../repositories/node-repository'
import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode } from '@shared/types'

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

function makeNodeData(): Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    type: 'feature',
    status: 'draft',
    title: 'N1',
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
  }
}

describe('NodeRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: NodeRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new NodeRepository(db)
  })

  it('create inserts a node and returns it', () => {
    const node = repo.create(makeNodeData())
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO nodes'))
    expect(node.title).toBe('N1')
    expect(node.type).toBe('feature')
  })

  it('createBatch returns empty for empty input', () => {
    expect(repo.createBatch([])).toEqual([])
  })

  it('createBatch inserts multiple nodes in transaction', () => {
    const nodes = repo.createBatch([makeNodeData(), makeNodeData()])
    expect(nodes).toHaveLength(2)
    expect(db.transaction).toHaveBeenCalled()
  })

  it('update modifies node fields', () => {
    stmt.get.mockReturnValueOnce({
      id: 'n1', type: 'feature', status: 'confirmed', title: 'Updated', description: null, acceptance_criteria: null,
      graph_id: 'g1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
      owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
    })
    const node = repo.update('n1', { status: 'confirmed', title: 'Updated' })
    expect(node.status).toBe('confirmed')
    expect(node.title).toBe('Updated')
  })

  it('getStatus returns node status', () => {
    stmt.get.mockReturnValueOnce({ status: 'developing' })
    expect(repo.getStatus('n1')).toBe('developing')
  })

  it('findById returns null when not found', () => {
    expect(repo.findById('missing')).toBeNull()
  })

  it('delete removes node', () => {
    repo.delete('n1')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM nodes'))
  })

  it('batchUpdatePositions updates positions in transaction', () => {
    repo.batchUpdatePositions([{ id: 'n1', x: 10, y: 20 }])
    expect(db.transaction).toHaveBeenCalled()
  })
})
