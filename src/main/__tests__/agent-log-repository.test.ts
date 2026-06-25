import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentLogRepository } from '../repositories/agent-log-repository'
import type BetterSqlite3 from 'better-sqlite3'
import { DatabaseError } from '../errors'

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
  } as unknown as BetterSqlite3.Database
  return { db, stmt: stmtMock }
}

describe('AgentLogRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: AgentLogRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new AgentLogRepository(db)
  })

  describe('parseRow', () => {
    it('returns AgentLog for valid row', () => {
      stmt.all.mockReturnValueOnce([{
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
      }])

      const logs = repo.listByNode('node-1')
      expect(logs).toHaveLength(1)
      expect(logs[0].id).toBe('log-1')
      expect(logs[0].command.type).toBe('implement')
      expect(logs[0].outputs).toEqual([{ type: 'stdout', data: 'ok' }])
      expect(logs[0].result).toBe('success')
    })

    it('uses non-null defaults for corrupted JSON fields', () => {
      stmt.all.mockReturnValueOnce([{
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
      }])

      const logs = repo.listByNode('node-2')
      expect(logs).toHaveLength(1)
      expect(logs[0].command).toEqual({ type: 'implement', description: '', targetNodeId: '' })
      expect(logs[0].outputs).toEqual([])
    })

    it('throws DatabaseError when required string field is missing', () => {
      stmt.all.mockReturnValueOnce([{
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
      }])

      expect(() => repo.listByNode('node-3')).toThrow(DatabaseError)
    })

    it('throws DatabaseError when result enum is invalid', () => {
      stmt.all.mockReturnValueOnce([{
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
      }])

      expect(() => repo.listByNode('node-4')).toThrow(DatabaseError)
    })

    it('throws DatabaseError when outputs is not an array after parse', () => {
      stmt.all.mockReturnValueOnce([{
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
      }])

      expect(() => repo.listByNode('node-5')).toThrow(DatabaseError)
    })

    it('throws DatabaseError when command shape is invalid', () => {
      stmt.all.mockReturnValueOnce([{
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
      }])

      expect(() => repo.listByNode('node-6')).toThrow(DatabaseError)
    })
  })
})
