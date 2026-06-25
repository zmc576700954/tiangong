import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BugRepository } from '../repositories/bug-repository'
import type BetterSqlite3 from 'better-sqlite3'

vi.mock('../shared/env', () => ({
  generateId: vi.fn().mockReturnValue('bug_test_001'),
  buildSafeEnv: vi.fn().mockReturnValue({}),
}))

function createMockDb() {
  const stmtMock = {
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(null),
    all: vi.fn().mockReturnValue([]),
  }
  const db = {
    prepare: vi.fn().mockReturnValue(stmtMock),
    transaction: vi.fn((fn: () => void) => () => fn()),
    exec: vi.fn(),
    pragma: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as BetterSqlite3.Database
  return { db, stmt: stmtMock }
}

describe('BugRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: BugRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new BugRepository(db)
  })

  describe('create', () => {
    it('插入 bug 并返回带 ID 和时间的对象', () => {
      const result = repo.create({
        title: 'Login Bug',
        description: 'Login fails',
        severity: 'high',
        status: 'open',
        nodeId: 'n1',
        graphId: 'g1',
      })

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO bug_nodes'))
      expect(result.id).toBe('bug_test_001')
      expect(result.title).toBe('Login Bug')
      expect(result.severity).toBe('high')
      expect(result.createdAt).toBeDefined()
    })
  })

  describe('update', () => {
    it('动态构建 UPDATE SQL', () => {
      const selectStmt = {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockReturnValue({
          id: 'b1', title: 'Updated Bug', description: 'fixed desc',
          severity: 'medium', status: 'fixed',
          node_id: 'n1', graph_id: 'g1',
          created_at: '2024-01-01', updated_at: '2024-01-02',
        }),
        all: vi.fn().mockReturnValue([]),
      }
      ;(db.prepare as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(stmt)  // UPDATE prepare
        .mockReturnValueOnce(selectStmt)  // SELECT prepare

      const result = repo.update('b1', { title: 'Updated Bug', status: 'fixed' })
      const updateSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(updateSql).toContain('title = ?')
      expect(updateSql).toContain('status = ?')
      expect(updateSql).toContain('updated_at = ?')
      expect(result.status).toBe('fixed')
    })

    it('severity 更新', () => {
      const selectStmt = {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockReturnValue({
          id: 'b1', title: 'Bug', description: 'd',
          severity: 'critical', status: 'open',
          node_id: 'n1', graph_id: 'g1',
          created_at: '2024-01-01', updated_at: '2024-01-02',
        }),
        all: vi.fn().mockReturnValue([]),
      }
      ;(db.prepare as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(stmt)
        .mockReturnValueOnce(selectStmt)

      repo.update('b1', { severity: 'critical' })
      const callSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(callSql).toContain('severity = ?')
    })
  })

  describe('delete', () => {
    it('执行 DELETE', () => {
      repo.delete('b1')
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM bug_nodes'))
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs).toContain('b1')
    })
  })

  describe('getStatus', () => {
    it('找到 → 返回 BugStatus', () => {
      stmt.get.mockReturnValueOnce({ status: 'open' })
      const status = repo.getStatus('b1')
      expect(status).toBe('open')
    })

    it('未找到 → null', () => {
      stmt.get.mockReturnValueOnce(undefined)
      const status = repo.getStatus('unknown')
      expect(status).toBeNull()
    })
  })

  describe('listByNode', () => {
    it('返回指定节点的所有 bug，按 created_at DESC', () => {
      stmt.all.mockReturnValueOnce([
        { id: 'b2', title: 'Bug2', description: 'd2', severity: 'low', status: 'open', node_id: 'n1', graph_id: 'g1', created_at: '2024-02-01', updated_at: '2024-02-01' },
        { id: 'b1', title: 'Bug1', description: 'd1', severity: 'high', status: 'fixed', node_id: 'n1', graph_id: 'g1', created_at: '2024-01-01', updated_at: '2024-01-15' },
      ])

      const bugs = repo.listByNode('n1')
      expect(bugs).toHaveLength(2)
      expect(bugs[0].id).toBe('b2')
      expect(bugs[1].severity).toBe('high')

      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('ORDER BY created_at DESC')
    })
  })
})
