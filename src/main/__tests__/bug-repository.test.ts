import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BugRepository } from '../repositories/bug-repository'
import type { Client, Row, ResultSet } from '@libsql/client'

vi.mock('../shared/env', () => ({
  generateId: vi.fn().mockReturnValue('bug_test_001'),
  buildSafeEnv: vi.fn().mockReturnValue({}),
}))

function createMockDb(): Client {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  } as unknown as Client
}

function mockRows(rows: Record<string, unknown>[]): ResultSet {
  return { rows: rows as unknown as Row[], columns: [], columnTypes: [], rowsAffected: 0, lastInsertRowid: 0n, toJSON: () => ({}) }
}

describe('BugRepository', () => {
  let db: Client
  let repo: BugRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new BugRepository(db)
  })

  describe('create', () => {
    it('插入 bug 并返回带 ID 和时间的对象', async () => {
      const result = await repo.create({
        title: 'Login Bug',
        description: 'Login fails',
        severity: 'high',
        status: 'open',
        nodeId: 'n1',
        graphId: 'g1',
      })

      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO bug_nodes'),
      }))
      expect(result.id).toBe('bug_test_001')
      expect(result.title).toBe('Login Bug')
      expect(result.severity).toBe('high')
      expect(result.createdAt).toBeDefined()
    })
  })

  describe('update', () => {
    it('动态构建 UPDATE SQL', async () => {
      (db.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows([])) // UPDATE
        .mockResolvedValueOnce(mockRows([{ // SELECT
          id: 'b1', title: 'Updated Bug', description: 'fixed desc',
          severity: 'medium', status: 'fixed',
          node_id: 'n1', graph_id: 'g1',
          created_at: '2024-01-01', updated_at: '2024-01-02',
        }]))

      const result = await repo.update('b1', { title: 'Updated Bug', status: 'fixed' })
      const updateCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(updateCall.sql).toContain('title = ?')
      expect(updateCall.sql).toContain('status = ?')
      expect(updateCall.sql).toContain('updated_at = ?')
      expect(result.status).toBe('fixed')
    })

    it('severity 更新', async () => {
      (db.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows([]))
        .mockResolvedValueOnce(mockRows([{
          id: 'b1', title: 'Bug', description: 'd',
          severity: 'critical', status: 'open',
          node_id: 'n1', graph_id: 'g1',
          created_at: '2024-01-01', updated_at: '2024-01-02',
        }]))

      await repo.update('b1', { severity: 'critical' })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('severity = ?')
    })
  })

  describe('delete', () => {
    it('执行 DELETE', async () => {
      await repo.delete('b1')
      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('DELETE FROM bug_nodes'),
        args: ['b1'],
      }))
    })
  })

  describe('getStatus', () => {
    it('找到 → 返回 BugStatus', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([
        { status: 'open' },
      ]))
      const status = await repo.getStatus('b1')
      expect(status).toBe('open')
    })

    it('未找到 → null', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      const status = await repo.getStatus('unknown')
      expect(status).toBeNull()
    })
  })

  describe('listByNode', () => {
    it('返回指定节点的所有 bug，按 created_at DESC', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([
        { id: 'b2', title: 'Bug2', description: 'd2', severity: 'low', status: 'open', node_id: 'n1', graph_id: 'g1', created_at: '2024-02-01', updated_at: '2024-02-01' },
        { id: 'b1', title: 'Bug1', description: 'd1', severity: 'high', status: 'fixed', node_id: 'n1', graph_id: 'g1', created_at: '2024-01-01', updated_at: '2024-01-15' },
      ]))

      const bugs = await repo.listByNode('n1')
      expect(bugs).toHaveLength(2)
      expect(bugs[0].id).toBe('b2')
      expect(bugs[1].severity).toBe('high')

      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('ORDER BY created_at DESC')
    })
  })
})
