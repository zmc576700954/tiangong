import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EdgeRepository } from '../repositories/edge-repository'
import type BetterSqlite3 from 'better-sqlite3'

// Mock generateId for predictable IDs
vi.mock('../shared/env', () => ({
  generateId: vi.fn().mockReturnValue('edge_test_001'),
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

describe('EdgeRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: EdgeRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new EdgeRepository(db)
  })

  describe('create', () => {
    it('插入边并返回带 ID 的对象', () => {
      const result = repo.create({
        source: 'node1',
        target: 'node2',
        label: 'triggers',
        graphId: 'g1',
        edgeType: 'default',
        description: 'desc',
        dataFlow: 'orderId',
        strength: 0.8,
        content: { condition: 'order > 0' },
      })

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO edges'))
      expect(result.id).toBe('edge_test_001')
      expect(result.source).toBe('node1')
      expect(result.target).toBe('node2')
      expect(result.content).toEqual({ condition: 'order > 0' })
    })

    it('可选字段为 null', () => {
      repo.create({
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
      })
      const callArgs = stmt.run.mock.calls[0]
      // label, edgeType, content, description, dataFlow, strength → null
      expect(callArgs[3]).toBeNull() // label
      expect(callArgs[4]).toBeNull() // edgeType
      expect(callArgs[5]).toBeNull() // content
    })

    it('content 序列化为 JSON', () => {
      repo.create({
        source: 'n1', target: 'n2', graphId: 'g1',
        content: { condition: 'x > 1', note: 'test' },
      })
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs[5]).toBe(JSON.stringify({ condition: 'x > 1', note: 'test' }))
    })
  })

  describe('update', () => {
    it('动态构建 UPDATE SQL', () => {
      const selectStmt = {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockReturnValue({
          id: 'e1', source: 'n1', target: 'n2', label: 'updated',
          edge_type: 'success', content: null, graph_id: 'g1',
          description: null, data_flow: null, strength: null,
        }),
        all: vi.fn().mockReturnValue([]),
      }
      ;(db.prepare as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(stmt) // UPDATE prepare
        .mockReturnValueOnce(selectStmt) // SELECT prepare

      repo.update('e1', { label: 'updated', edgeType: 'success' })

      const updateSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(updateSql).toContain('label = ?')
      expect(updateSql).toContain('edge_type = ?')
      expect(updateSql).not.toContain('description')
    })

    it('空更新 → 跳过 UPDATE', () => {
      const selectStmt = {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockReturnValue({
          id: 'e1', source: 'n1', target: 'n2', label: null,
          edge_type: null, content: null, graph_id: 'g1',
          description: null, data_flow: null, strength: null,
        }),
        all: vi.fn().mockReturnValue([]),
      }
      ;(db.prepare as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(selectStmt) // SELECT only

      repo.update('e1', {})
      expect(db.prepare).toHaveBeenCalledTimes(1) // Only SELECT, no UPDATE
    })

    it('未找到 → 抛出 DatabaseError', () => {
      const selectStmt = {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockReturnValue(undefined), // SELECT → empty
        all: vi.fn().mockReturnValue([]),
      }
      ;(db.prepare as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(stmt) // UPDATE prepare
        .mockReturnValueOnce(selectStmt) // SELECT prepare

      expect(() => repo.update('nonexistent', { label: 'x' }))
        .toThrow('Edge not found')
    })

    it('content 更新 → JSON 序列化', () => {
      const selectStmt = {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockReturnValue({
          id: 'e1', source: 'n1', target: 'n2', label: null,
          edge_type: null, content: '{"note":"new"}', graph_id: 'g1',
          description: null, data_flow: null, strength: null,
        }),
        all: vi.fn().mockReturnValue([]),
      }
      ;(db.prepare as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(stmt)
        .mockReturnValueOnce(selectStmt)

      repo.update('e1', { content: { note: 'new' } })
      const updateCallArgs = stmt.run.mock.calls[0]
      expect(updateCallArgs[0]).toBe(JSON.stringify({ note: 'new' }))
    })
  })

  describe('delete', () => {
    it('执行 DELETE', () => {
      repo.delete('e1')
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM edges'))
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs).toContain('e1')
    })
  })

  describe('listByGraph', () => {
    it('查询指定图的所有边', () => {
      stmt.all.mockReturnValueOnce([
        { id: 'e1', source: 'n1', target: 'n2', label: null, edge_type: null, content: null, graph_id: 'g1', description: null, data_flow: null, strength: null },
        { id: 'e2', source: 'n2', target: 'n3', label: 'next', edge_type: 'success', content: '{"condition":"ok"}', graph_id: 'g1', description: 'desc', data_flow: 'data', strength: 0.5 },
      ])

      const edges = repo.listByGraph('g1')
      expect(edges).toHaveLength(2)
      expect(edges[0].id).toBe('e1')
      expect(edges[1].content).toEqual({ condition: 'ok' })
      expect(edges[1].strength).toBe(0.5)
    })
  })

  describe('parseEdgeRow 内容解析', () => {
    it('无效 JSON content → undefined', () => {
      stmt.all.mockReturnValueOnce([
        { id: 'e1', source: 'n1', target: 'n2', label: null, edge_type: null, content: 'invalid json{', graph_id: 'g1', description: null, data_flow: null, strength: null },
      ])

      const edges = repo.listByGraph('g1')
      expect(edges[0].content).toBeUndefined()
    })

    it('null content → undefined', () => {
      stmt.all.mockReturnValueOnce([
        { id: 'e1', source: 'n1', target: 'n2', label: null, edge_type: null, content: null, graph_id: 'g1', description: null, data_flow: null, strength: null },
      ])

      const edges = repo.listByGraph('g1')
      expect(edges[0].content).toBeUndefined()
    })
  })
})
