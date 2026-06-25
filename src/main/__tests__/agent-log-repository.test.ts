import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentLogRepository } from '../repositories/agent-log-repository'
import type { Client, Row, ResultSet } from '@libsql/client'
import { DatabaseError } from '../errors'

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

describe('AgentLogRepository', () => {
  let db: Client
  let repo: AgentLogRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new AgentLogRepository(db)
  })

  describe('parseRow', () => {
    it('returns AgentLog for valid row', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'log-1',
        session_id: 'session-1',
        adapter_name: 'claude-code',
        node_id: 'node-1',
        graph_id: 'graph-1',
        command: JSON.stringify({ type: 'implement', description: 'do it', targetNodeId: 'node-1' }),
        outputs: JSON.stringify([{ type: 'stdout', data: 'ok' }]),
        result: 'success',
        duration: 1234,
        created_at: '2025-01-01T00:00:00Z',
      }]))

      const logs = await repo.listByNode('node-1')
      expect(logs).toHaveLength(1)
      expect(logs[0].id).toBe('log-1')
      expect(logs[0].command.type).toBe('implement')
      expect(logs[0].outputs).toEqual([{ type: 'stdout', data: 'ok' }])
      expect(logs[0].result).toBe('success')
    })

    it('uses non-null defaults for corrupted JSON fields', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'log-2',
        session_id: 'session-2',
        adapter_name: 'codex',
        node_id: 'node-2',
        graph_id: 'graph-2',
        command: 'not-json',
        outputs: 'also-not-json',
        result: 'failure',
        duration: 0,
        created_at: '2025-01-02T00:00:00Z',
      }]))

      const logs = await repo.listByNode('node-2')
      expect(logs).toHaveLength(1)
      expect(logs[0].command).toEqual({ type: 'implement', description: '', targetNodeId: '' })
      expect(logs[0].outputs).toEqual([])
    })

    it('throws DatabaseError when required string field is missing', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'log-3',
        session_id: null,
        adapter_name: 'codex',
        node_id: 'node-3',
        graph_id: 'graph-3',
        command: JSON.stringify({ type: 'implement', description: '' }),
        outputs: JSON.stringify([]),
        result: 'success',
        duration: 0,
        created_at: '2025-01-03T00:00:00Z',
      }]))

      await expect(repo.listByNode('node-3')).rejects.toThrow(DatabaseError)
    })

    it('throws DatabaseError when result enum is invalid', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'log-4',
        session_id: 'session-4',
        adapter_name: 'codex',
        node_id: 'node-4',
        graph_id: 'graph-4',
        command: JSON.stringify({ type: 'implement', description: '' }),
        outputs: JSON.stringify([]),
        result: 'unknown',
        duration: 0,
        created_at: '2025-01-04T00:00:00Z',
      }]))

      await expect(repo.listByNode('node-4')).rejects.toThrow(DatabaseError)
    })

    it('throws DatabaseError when outputs is not an array after parse', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'log-5',
        session_id: 'session-5',
        adapter_name: 'codex',
        node_id: 'node-5',
        graph_id: 'graph-5',
        command: JSON.stringify({ type: 'implement', description: '' }),
        outputs: JSON.stringify({ not: 'array' }),
        result: 'success',
        duration: 0,
        created_at: '2025-01-05T00:00:00Z',
      }]))

      await expect(repo.listByNode('node-5')).rejects.toThrow(DatabaseError)
    })

    it('throws DatabaseError when command shape is invalid', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'log-6',
        session_id: 'session-6',
        adapter_name: 'codex',
        node_id: 'node-6',
        graph_id: 'graph-6',
        command: JSON.stringify({ type: 'implement' }),
        outputs: JSON.stringify([]),
        result: 'success',
        duration: 0,
        created_at: '2025-01-06T00:00:00Z',
      }]))

      await expect(repo.listByNode('node-6')).rejects.toThrow(DatabaseError)
    })
  })
})
