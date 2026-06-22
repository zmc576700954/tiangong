import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type { Client, Row, ResultSet } from '@libsql/client'

function createMockDb(): Client {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  } as unknown as Client
}

function mockRows(rows: Record<string, unknown>[]): ResultSet {
  return {
    rows: rows as unknown as Row[],
    columns: [],
    columnTypes: [],
    rowsAffected: 0,
    lastInsertRowid: 0n,
    toJSON: () => ({}),
  }
}

describe('CompactHistoryRepository', () => {
  let db: Client
  let repo: CompactHistoryRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new CompactHistoryRepository(db)
  })

  describe('insert', () => {
    it('persists a CompactResult and returns the generated id', async () => {
      const id = await repo.insert({
        threadId: 't1',
        sessionId: 's1',
        strategy: 'native',
        trigger: 'manual',
        tokensBefore: 150_000,
        tokensAfter: 30_000,
        summary: 'short summary',
        startedAt: 1_700_000_000_000,
        durationMs: 1234,
      })

      expect(id).toMatch(/^compact-/)
      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO compact_history'),
      }))
    })

    it('accepts null thread_id and session_id and null summary', async () => {
      const id = await repo.insert({
        threadId: null,
        sessionId: null,
        strategy: 'summary',
        trigger: 'auto-threshold',
        tokensBefore: 10,
        tokensAfter: 5,
        summary: null,
        startedAt: 0,
        durationMs: 0,
      })
      expect(id).toMatch(/^compact-/)
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args[1]).toBeNull() // thread_id
      expect(call.args[2]).toBeNull() // session_id
      expect(call.args[7]).toBeNull() // summary
    })
  })

  describe('listByThread', () => {
    it('returns rows ordered by started_at DESC', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([
        {
          id: 'compact-aaa', thread_id: 't1', session_id: 's1',
          strategy: 'native', trigger: 'manual',
          tokens_before: 100, tokens_after: 50,
          summary: 's', started_at: 2, duration_ms: 10,
        },
        {
          id: 'compact-bbb', thread_id: 't1', session_id: 's1',
          strategy: 'summary', trigger: 'auto-threshold',
          tokens_before: 80, tokens_after: 40,
          summary: null, started_at: 1, duration_ms: 5,
        },
      ]))

      const rows = await repo.listByThread('t1')

      expect(rows).toHaveLength(2)
      expect(rows[0].id).toBe('compact-aaa')
      expect(rows[0].threadId).toBe('t1')
      expect(rows[0].tokensBefore).toBe(100)
      expect(rows[1].summary).toBeNull()
      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('ORDER BY started_at DESC'),
      }))
    })

    it('respects limit', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([]))
      await repo.listByThread('t1', 5)
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args).toEqual(['t1', 5])
    })
  })
})
