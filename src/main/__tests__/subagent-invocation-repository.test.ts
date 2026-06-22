import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubagentInvocationRepository } from '../repositories/subagent-invocation-repository'
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

describe('SubagentInvocationRepository', () => {
  let db: Client
  let repo: SubagentInvocationRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new SubagentInvocationRepository(db)
  })

  describe('create', () => {
    it('inserts a queued invocation and returns the generated id', async () => {
      const id = await repo.create({
        parentSessionId: 'p1',
        agentType: 'explore',
        description: 'find auth',
        prompt: 'Look for auth entry points',
        startedAt: 1_700_000_000_000,
      })

      expect(id).toMatch(/^inv-/)
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('INSERT INTO subagent_invocations')
      // status defaults to 'queued'
      const queuedIndex = call.args.indexOf('queued')
      expect(queuedIndex).toBeGreaterThanOrEqual(0)
    })

    it('serialises allowed_files as JSON', async () => {
      await repo.create({
        parentSessionId: 'p1',
        agentType: 'implement',
        description: 'edit',
        prompt: 'do it',
        allowedFiles: ['src/a.ts', 'src/b.ts'],
        startedAt: 0,
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const args = call.args as unknown[]
      const allowedFilesArg = args.find((v) => typeof v === 'string' && v.startsWith('['))
      expect(allowedFilesArg).toBe(JSON.stringify(['src/a.ts', 'src/b.ts']))
    })
  })

  describe('updateStatus', () => {
    it('updates status only', async () => {
      await repo.updateStatus('inv-xx', 'running')
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('UPDATE subagent_invocations SET status = ?')
      expect(call.args).toEqual(['running', 'inv-xx'])
    })
  })

  describe('complete', () => {
    it('writes terminal fields and status=completed', async () => {
      await repo.complete('inv-xx', {
        resultText: 'done',
        resultFiles: ['src/x.ts'],
        tokensUsed: 1234,
        finishedAt: 1_700_000_100_000,
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('UPDATE subagent_invocations')
      expect(call.sql).toContain('status = ?')
      expect(call.sql).toContain('result_text = ?')
      expect(call.sql).toContain('result_files = ?')
      expect(call.sql).toContain('tokens_used = ?')
      expect(call.sql).toContain('finished_at = ?')
      // Last arg is the id.
      const args = call.args as unknown[]
      expect(args[args.length - 1]).toBe('inv-xx')
      // 'completed' status was passed.
      expect(args).toContain('completed')
      // result_files JSON-encoded.
      expect(args).toContain(JSON.stringify(['src/x.ts']))
    })
  })

  describe('fail', () => {
    it('writes error and status=failed', async () => {
      await repo.fail('inv-xx', { error: 'boom', finishedAt: 1 })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      const args = call.args as unknown[]
      expect(args).toContain('failed')
      expect(args).toContain('boom')
    })
  })

  describe('listByParent', () => {
    it('returns deserialised rows', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([
        {
          id: 'inv-1', parent_session_id: 'p1', parent_message_id: null,
          graph_id: 'g1', agent_type: 'explore', description: 'd', prompt: 'p',
          adapter_name: 'claude-code', node_id: null,
          allowed_files: '["src/a.ts"]',
          status: 'completed', result_text: 'r', result_files: '["src/a.ts"]',
          tokens_used: 100, started_at: 1, finished_at: 2, error: null,
        },
      ]))

      const rows = await repo.listByParent('p1')
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('inv-1')
      expect(rows[0].allowedFiles).toEqual(['src/a.ts'])
      expect(rows[0].resultFiles).toEqual(['src/a.ts'])
      expect(rows[0].status).toBe('completed')
    })

    it('handles malformed JSON in allowed_files gracefully', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([
        {
          id: 'inv-2', parent_session_id: 'p1', parent_message_id: null,
          graph_id: null, agent_type: 'fix', description: 'd', prompt: 'p',
          adapter_name: null, node_id: null,
          allowed_files: 'not-json',
          status: 'queued', result_text: null, result_files: null,
          tokens_used: 0, started_at: 0, finished_at: null, error: null,
        },
      ]))
      const rows = await repo.listByParent('p1')
      expect(rows[0].allowedFiles).toBeNull()
    })
  })

  describe('get', () => {
    it('returns null when not found', async () => {
      ;(db.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRows([]))
      const row = await repo.get('inv-missing')
      expect(row).toBeNull()
    })
  })
})