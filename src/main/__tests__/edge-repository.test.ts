import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EdgeRepository } from '../repositories/edge-repository'
import type { Client, Row, ResultSet } from '@libsql/client'

// Mock generateId for predictable IDs
vi.mock('../shared/env', () => ({
  generateId: vi.fn().mockReturnValue('edge_test_001'),
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

describe('EdgeRepository', () => {
  let db: Client
  let repo: EdgeRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new EdgeRepository(db)
  })

  describe('create', () => {
    it('插入边并返回带 ID 的对象', async () => {
      const result = await repo.create({
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

      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO edges'),
      }))
      expect(result.id).toBe('edge_test_001')
      expect(result.source).toBe('node1')
      expect(result.target).toBe('node2')
      expect(result.content).toEqual({ condition: 'order > 0' })
    })

    it('可选字段为 null', async () => {
      await repo.create({
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      // label, edgeType, content, description, dataFlow, strength → null
      expect(call.args[3]).toBeNull() // label
      expect(call.args[4]).toBeNull() // edgeType
      expect(call.args[5]).toBeNull() // content
    })

    it('content 序列化为 JSON', async () => {
      await repo.create({
        source: 'n1', target: 'n2', graphId: 'g1',
        content: { condition: 'x > 1', note: 'test' },
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args[5]).toBe(JSON.stringify({ condition: 'x > 1', note: 'test' }))
    })
  })

  describe('update', () => {
    it('动态构建 UPDATE SQL', async () => {
      (db.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows([])) // UPDATE
        .mockResolvedValueOnce(mockRows([{ // SELECT
          id: 'e1', source: 'n1', target: 'n2', label: 'updated',
          edge_type: 'success', content: null, graph_id: 'g1',
          description: null, data_flow: null, strength: null,
        }]))

      await repo.update('e1', { label: 'updated', edgeType: 'success' })

      const updateCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(updateCall.sql).toContain('label = ?')
      expect(updateCall.sql).toContain('edge_type = ?')
      expect(updateCall.sql).not.toContain('description')
    })

    it('空更新 → 跳过 UPDATE', async () => {
      (db.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows([{ // SELECT only
          id: 'e1', source: 'n1', target: 'n2', label: null,
          edge_type: null, content: null, graph_id: 'g1',
          description: null, data_flow: null, strength: null,
        }]))

      await repo.update('e1', {})
      expect(db.execute).toHaveBeenCalledTimes(1) // Only SELECT, no UPDATE
    })

    it('未找到 → 抛出 DatabaseError', async () => {
      (db.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows([])) // UPDATE
        .mockResolvedValueOnce(mockRows([])) // SELECT → empty

      await expect(repo.update('nonexistent', { label: 'x' }))
        .rejects.toThrow('Edge not found')
    })

    it('content 更新 → JSON 序列化', async () => {
      (db.execute as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(mockRows([]))
        .mockResolvedValueOnce(mockRows([{
          id: 'e1', source: 'n1', target: 'n2', label: null,
          edge_type: null, content: '{"note":"new"}', graph_id: 'g1',
          description: null, data_flow: null, strength: null,
        }]))

      await repo.update('e1', { content: { note: 'new' } })
      const updateCall = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(updateCall.args[0]).toBe(JSON.stringify({ note: 'new' }))
    })
  })

  describe('delete', () => {
    it('执行 DELETE', async () => {
      await repo.delete('e1')
      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('DELETE FROM edges'),
        args: ['e1'],
      }))
    })
  })

  describe('listByGraph', () => {
    it('查询指定图的所有边', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([
        { id: 'e1', source: 'n1', target: 'n2', label: null, edge_type: null, content: null, graph_id: 'g1', description: null, data_flow: null, strength: null },
        { id: 'e2', source: 'n2', target: 'n3', label: 'next', edge_type: 'success', content: '{"condition":"ok"}', graph_id: 'g1', description: 'desc', data_flow: 'data', strength: 0.5 },
      ]))

      const edges = await repo.listByGraph('g1')
      expect(edges).toHaveLength(2)
      expect(edges[0].id).toBe('e1')
      expect(edges[1].content).toEqual({ condition: 'ok' })
      expect(edges[1].strength).toBe(0.5)
    })
  })

  describe('parseEdgeRow 内容解析', () => {
    it('无效 JSON content → undefined', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([
        { id: 'e1', source: 'n1', target: 'n2', label: null, edge_type: null, content: 'invalid json{', graph_id: 'g1', description: null, data_flow: null, strength: null },
      ]))

      const edges = await repo.listByGraph('g1')
      expect(edges[0].content).toBeUndefined()
    })

    it('null content → undefined', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([
        { id: 'e1', source: 'n1', target: 'n2', label: null, edge_type: null, content: null, graph_id: 'g1', description: null, data_flow: null, strength: null },
      ]))

      const edges = await repo.listByGraph('g1')
      expect(edges[0].content).toBeUndefined()
    })
  })
})
