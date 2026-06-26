import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SnapshotRepository } from '../repositories/snapshot-repository'
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

describe('SnapshotRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: SnapshotRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new SnapshotRepository(db)
  })

  it('create inserts snapshot and returns it', () => {
    const snapshot = repo.create('g1', 'v1', [], [], 'abc123')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO snapshots'))
    expect(snapshot.graphId).toBe('g1')
    expect(snapshot.name).toBe('v1')
    expect(snapshot.gitCommit).toBe('abc123')
  })

  it('listByGraph returns snapshots without data', () => {
    stmt.all.mockReturnValueOnce([
      { id: 's1', graph_id: 'g1', name: 'v1', git_commit: 'abc', created_at: '2024-01-01' },
    ])
    const list = repo.listByGraph('g1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('s1')
  })

  it('pruneOldSnapshots deletes old snapshot ids', () => {
    stmt.all.mockReturnValueOnce([{ id: 'old1' }, { id: 'old2' }])
    repo.pruneOldSnapshots('g1', 5)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM snapshots'))
  })

  it('load returns parsed snapshot', () => {
    stmt.get.mockReturnValueOnce({
      id: 's1', graph_id: 'g1', name: 'v1', data: JSON.stringify({ nodes: [], edges: [] }), git_commit: 'abc', created_at: '2024-01-01',
    })
    const snapshot = repo.load('s1')
    expect(snapshot).not.toBeNull()
    expect(snapshot!.data.nodes).toEqual([])
  })

  it('load returns null when snapshot not found', () => {
    expect(repo.load('missing')).toBeNull()
  })

  it('delete removes snapshot', () => {
    repo.delete('s1')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM snapshots'))
  })
})
