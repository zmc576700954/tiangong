import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
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

describe('SubagentInvocationRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: SubagentInvocationRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new SubagentInvocationRepository(db)
  })

  describe('create', () => {
    it('inserts a queued invocation and returns the generated id', () => {
      const id = repo.create({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'find auth',
        prompt: 'Look for auth entry points',
        startedAt: 1_700_000_000_000,
      })

      expect(id).toMatch(/^inv-/)
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('INSERT INTO subagent_invocations')
      // status defaults to 'queued'
      const callArgs = stmt.run.mock.calls[0]
      const queuedIndex = callArgs.indexOf('queued')
      expect(queuedIndex).toBeGreaterThanOrEqual(0)
    })

    it('serialises allowed_files as JSON', () => {
      repo.create({
        parentSessionId: 'p1',
        agentType: 'implement',
        description: 'edit',
        prompt: 'do it',
        allowedFiles: ['src/a.ts', 'src/b.ts'],
        startedAt: 0,
      })
      const callArgs = stmt.run.mock.calls[0] as unknown[]
      const allowedFilesArg = callArgs.find((v) => typeof v === 'string' && v.startsWith('['))
      expect(allowedFilesArg).toBe(JSON.stringify(['src/a.ts', 'src/b.ts']))
    })
  })

  describe('updateStatus', () => {
    it('updates status only', () => {
      repo.updateStatus('inv-xx', 'running')
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('UPDATE subagent_invocations SET status = ?')
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs).toEqual(['running', 'inv-xx'])
    })
  })

  describe('complete', () => {
    it('writes terminal fields and status=completed', () => {
      repo.complete('inv-xx', {
        resultText: 'done',
        resultFiles: ['src/x.ts'],
        tokensUsed: 1234,
        finishedAt: 1_700_000_100_000,
      })
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('UPDATE subagent_invocations')
      expect(sql).toContain('status = ?')
      expect(sql).toContain('result_text = ?')
      expect(sql).toContain('result_files = ?')
      expect(sql).toContain('tokens_used = ?')
      expect(sql).toContain('finished_at = ?')
      const callArgs = stmt.run.mock.calls[0] as unknown[]
      // Last arg is the id.
      expect(callArgs[callArgs.length - 1]).toBe('inv-xx')
      // 'completed' status was passed.
      expect(callArgs).toContain('completed')
      // result_files JSON-encoded.
      expect(callArgs).toContain(JSON.stringify(['src/x.ts']))
    })
  })

  describe('fail', () => {
    it('writes error and status=failed', () => {
      repo.fail('inv-xx', { error: 'boom', finishedAt: 1 })
      const callArgs = stmt.run.mock.calls[0] as unknown[]
      expect(callArgs).toContain('failed')
      expect(callArgs).toContain('boom')
    })
  })

  describe('listByParent', () => {
    it('returns deserialised rows', () => {
      stmt.all.mockReturnValueOnce([
        {
          id: 'inv-1', parent_session_id: 'p1', parent_message_id: null,
          graph_id: 'g1', agent_type: 'explore', description: 'd', prompt: 'p',
          adapter_name: 'claude-code', node_id: null,
          allowed_files: '["src/a.ts"]',
          status: 'completed', result_text: 'r', result_files: '["src/a.ts"]',
          tokens_used: 100, started_at: 1, finished_at: 2, error: null,
        },
      ])

      const rows = repo.listByParent('p1')
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('inv-1')
      expect(rows[0].allowedFiles).toEqual(['src/a.ts'])
      expect(rows[0].resultFiles).toEqual(['src/a.ts'])
      expect(rows[0].status).toBe('completed')
    })

    it('handles malformed JSON in allowed_files gracefully', () => {
      stmt.all.mockReturnValueOnce([
        {
          id: 'inv-2', parent_session_id: 'p1', parent_message_id: null,
          graph_id: null, agent_type: 'fix', description: 'd', prompt: 'p',
          adapter_name: null, node_id: null,
          allowed_files: 'not-json',
          status: 'queued', result_text: null, result_files: null,
          tokens_used: 0, started_at: 0, finished_at: null, error: null,
        },
      ])
      const rows = repo.listByParent('p1')
      expect(rows[0].allowedFiles).toBeNull()
    })
  })

  describe('get', () => {
    it('returns null when not found', () => {
      stmt.get.mockReturnValueOnce(undefined)
      const row = repo.get('inv-missing')
      expect(row).toBeNull()
    })
  })
})
