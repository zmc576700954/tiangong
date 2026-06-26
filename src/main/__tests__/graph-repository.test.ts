import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphRepository } from '../repositories/graph-repository'
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

describe('GraphRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: GraphRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new GraphRepository(db)
  })

  it('create inserts a graph and returns it', () => {
    const graph = repo.create({ name: 'Test', type: 'online', projectPath: '/project' })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO graphs'))
    expect(graph.name).toBe('Test')
    expect(graph.type).toBe('online')
    expect(graph.projectPath).toBe('/project')
  })

  it('list returns mapped graphs', () => {
    stmt.all.mockReturnValueOnce([{
      id: 'g1', name: 'G1', type: 'online', project_path: '/p1', created_at: '2024-01-01', updated_at: '2024-01-01',
    }])
    const graphs = repo.list()
    expect(graphs).toHaveLength(1)
    expect(graphs[0].id).toBe('g1')
  })

  it('get returns null when graph not found', () => {
    stmt.get.mockReturnValueOnce(undefined)
    expect(repo.get('missing')).toBeNull()
  })

  it('get returns graph with nodes, edges, bugs', () => {
    stmt.get
      .mockReturnValueOnce({ id: 'g1', name: 'G1', type: 'online', project_path: null, created_at: '2024-01-01', updated_at: '2024-01-01' })
    stmt.all
      .mockReturnValueOnce([{
        id: 'n1', type: 'feature', status: 'draft', title: 'N1', description: null, acceptance_criteria: null,
        graph_id: 'g1', graph_type: 'online', parent_id: null, rules: null, metadata: null, content: null,
        community_summary: null, community_level: null, context_refs: null, owner_role: null,
        position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      }])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])

    const result = repo.get('g1')
    expect(result).not.toBeNull()
    expect(result!.graph.id).toBe('g1')
    expect(result!.nodes).toHaveLength(1)
  })

  it('delete runs cascading delete in transaction', () => {
    repo.delete('g1')
    expect(db.transaction).toHaveBeenCalled()
    expect(stmt.run).toHaveBeenCalledTimes(6)
  })

  it('getProjectPaths filters null paths', () => {
    stmt.all.mockReturnValueOnce([
      { project_path: '/p1' },
      { project_path: null },
      { project_path: '/p2' },
    ])
    const paths = repo.getProjectPaths()
    expect(paths).toEqual(['/p1', '/p2'])
  })
})
