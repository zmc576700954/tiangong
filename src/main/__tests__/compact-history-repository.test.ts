import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CompactHistoryRepository } from '../repositories/compact-history-repository'
import type BetterSqlite3 from 'better-sqlite3'

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

describe('CompactHistoryRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: CompactHistoryRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new CompactHistoryRepository(db)
  })

  describe('insert', () => {
    it('persists a CompactResult and returns the generated id', () => {
      const id = repo.insert({
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
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO compact_history'))
    })

    it('accepts null thread_id and session_id and null summary', () => {
      const id = repo.insert({
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
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs[1]).toBeNull() // thread_id
      expect(callArgs[2]).toBeNull() // session_id
      expect(callArgs[7]).toBeNull() // summary
    })
  })

  describe('listByThread', () => {
    it('returns rows ordered by started_at DESC', () => {
      stmt.all.mockReturnValueOnce([
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
      ])

      const rows = repo.listByThread('t1')

      expect(rows).toHaveLength(2)
      expect(rows[0].id).toBe('compact-aaa')
      expect(rows[0].threadId).toBe('t1')
      expect(rows[0].tokensBefore).toBe(100)
      expect(rows[1].summary).toBeNull()
      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('ORDER BY started_at DESC'))
    })

    it('respects limit', () => {
      repo.listByThread('t1', 5)
      const callArgs = stmt.all.mock.calls[0]
      expect(callArgs).toEqual(['t1', 5])
    })
  })
})
