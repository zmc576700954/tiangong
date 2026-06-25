import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatRepository } from '../repositories/chat-repository'
import type BetterSqlite3 from 'better-sqlite3'

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
  } as unknown as BetterSqlite3.Database & { _stmt: typeof stmtMock }
  // Attach stmt for test access
  ;(db as Record<string, unknown>)._stmt = stmtMock
  return { db, stmt: stmtMock }
}

describe('ChatRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: ChatRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new ChatRepository(db)
  })

  // ==================== Thread CRUD ====================
  describe('createThread', () => {
    it('插入线程并返回', () => {
      const result = repo.createThread({
        id: 't1',
        title: 'Test Thread',
        adapterName: 'claude-code',
        nodeId: 'n1',
        graphId: 'g1',
        sessionId: 's1',
      })

      expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO chat_threads'))
      expect(result.id).toBe('t1')
      expect(result.title).toBe('Test Thread')
      expect(result.adapter_name).toBe('claude-code')
      expect(result.node_id).toBe('n1')
      expect(result.status).toBe('active')
    })

    it('可选字段为 null', () => {
      const result = repo.createThread({
        id: 't2',
        title: 'Simple',
        adapterName: 'claude-code',
      })
      expect(result.node_id).toBeNull()
      expect(result.graph_id).toBeNull()
      expect(result.session_id).toBeNull()
    })
  })

  describe('getThread', () => {
    it('找到线程 → 返回 ChatThreadRow', () => {
      stmt.get.mockReturnValueOnce({
        id: 't1', title: 'Thread', adapter_name: 'claude-code',
        node_id: 'n1', graph_id: null, session_id: null,
        status: 'active', created_at: 1000, updated_at: 2000,
        parent_thread_id: null, context_tokens_used: 0, context_window_max: 200000,
        last_compacted_at: null,
      })

      const thread = repo.getThread('t1')
      expect(thread).not.toBeNull()
      expect(thread!.id).toBe('t1')
      expect(thread!.created_at).toBe(1000)
    })

    it('缺少必填字段 → 抛出 DatabaseError', () => {
      stmt.get.mockReturnValueOnce({
        id: 't1', title: 'Thread',
        // 缺少 adapter_name / status / created_at / updated_at / context_tokens_used / context_window_max
      })

      expect(() => repo.getThread('t1')).toThrow('Missing required field')
    })

    it('未找到 → null', () => {
      stmt.get.mockReturnValueOnce(undefined)
      const thread = repo.getThread('unknown')
      expect(thread).toBeNull()
    })
  })

  describe('listThreads', () => {
    it('无过滤器 → 查询所有', () => {
      repo.listThreads()
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('WHERE 1=1')
      expect(sql).not.toContain('node_id = ?')
    })

    it('带 nodeId 过滤', () => {
      repo.listThreads({ nodeId: 'n1' })
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('node_id = ?')
      const runArgs = stmt.all.mock.calls[0]
      expect(runArgs).toContain('n1')
    })

    it('带 graphId 和 status 过滤', () => {
      repo.listThreads({ graphId: 'g1', status: 'active' })
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('graph_id = ?')
      expect(sql).toContain('status = ?')
    })

    it('结果按 updated_at DESC 排序', () => {
      repo.listThreads()
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('ORDER BY updated_at DESC')
    })
  })

  describe('updateThread', () => {
    it('更新 title 和 status', () => {
      repo.updateThread('t1', { title: 'New Title', status: 'archived' })
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('title = ?')
      expect(sql).toContain('status = ?')
      const runArgs = stmt.run.mock.calls[0]
      expect(runArgs).toContain('New Title')
      expect(runArgs).toContain('archived')
    })

    it('空更新 → 不执行 SQL', () => {
      repo.updateThread('t1', {})
      expect(db.prepare).not.toHaveBeenCalled()
    })

    it('更新 sessionId', () => {
      repo.updateThread('t1', { sessionId: 'new-session' })
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('session_id = ?')
    })
  })

  describe('deleteThread', () => {
    it('级联删除消息和线程', () => {
      repo.deleteThread('t1')
      expect(db.transaction).toHaveBeenCalled()
    })
  })

  describe('searchThreads', () => {
    it('LIKE 搜索转义百分号并声明 ESCAPE', () => {
      repo.searchThreads('100%')
      const callArgs = stmt.all.mock.calls[0]
      expect(callArgs[0]).toBe('%100\\%%')
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain("ESCAPE '\\'")
    })

    it('LIKE 搜索转义下划线并声明 ESCAPE', () => {
      repo.searchThreads('a_b')
      const callArgs = stmt.all.mock.calls[0]
      expect(callArgs[0]).toBe('%a\\_b%')
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain("ESCAPE '\\'")
    })

    it('LIKE 搜索同时转义反斜杠本身', () => {
      repo.searchThreads('a\\b')
      const callArgs = stmt.all.mock.calls[0]
      expect(callArgs[0]).toBe('%a\\\\b%')
    })

    it('JOIN chat_messages 搜索', () => {
      repo.searchThreads('keyword')
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('LEFT JOIN chat_messages')
      expect(sql).toContain('m.content LIKE ?')
    })
  })

  describe('archiveStaleThreads', () => {
    it('uses numeric millisecond cutoff', () => {
      stmt.run.mockReturnValueOnce({ changes: 3, lastInsertRowid: 1 })
      const result = repo.archiveStaleThreads('g1', 1700000000000)
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs).toEqual(['g1', 1700000000000])
      expect(typeof callArgs[1]).toBe('number')
      expect(result).toBe(3)
    })
  })

  describe('cleanupArchivedThreads', () => {
    it('uses numeric millisecond cutoff', () => {
      stmt.run.mockReturnValueOnce({ changes: 5, lastInsertRowid: 1 })
      const result = repo.cleanupArchivedThreads(1690000000000)
      const callArgs = stmt.run.mock.calls[0]
      expect(callArgs).toEqual([1690000000000])
      expect(typeof callArgs[0]).toBe('number')
      expect(result).toBe(5)
    })
  })

  // ==================== Message CRUD ====================
  describe('saveMessage', () => {
    it('INSERT OR REPLACE 单条消息', () => {
      repo.saveMessage({
        id: 'm1', threadId: 't1', role: 'user', content: 'hello',
        adapterName: 'claude-code', status: 'success', createdAt: 1000,
      })
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('INSERT OR REPLACE INTO chat_messages')
    })
  })

  describe('saveMessages', () => {
    it('批量保存使用 transaction', () => {
      const messages = [
        { id: 'm1', threadId: 't1', role: 'user', content: 'hello', adapterName: 'claude', status: 'success', createdAt: 1000 },
        { id: 'm2', threadId: 't1', role: 'agent', content: 'hi', adapterName: 'claude', status: 'success', createdAt: 1001 },
      ]
      repo.saveMessages(messages)
      expect(db.transaction).toHaveBeenCalled()
    })

    it('空数组 → 不执行', () => {
      repo.saveMessages([])
      expect(db.transaction).not.toHaveBeenCalled()
    })
  })

  describe('listMessages', () => {
    it('按 created_at ASC 排序', () => {
      repo.listMessages('t1')
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(sql).toContain('ORDER BY created_at ASC')
    })
  })

  describe('toChatMessageRow 字段处理', () => {
    it('null 字段正确处理', () => {
      stmt.all.mockReturnValueOnce([{
        id: 'm1', thread_id: 't1', role: 'agent', content: 'test',
        adapter_name: 'claude', status: 'success',
        error: null, session_id: null, context_refs: null, tool_calls: null,
        created_at: 1000, token_count: 0,
      }])

      const messages = repo.listMessages('t1')
      expect(messages).toHaveLength(1)
      expect(messages[0].error).toBeNull()
      expect(messages[0].session_id).toBeNull()
      expect(messages[0].context_refs).toBeNull()
      expect(messages[0].tool_calls).toBeNull()
    })

    it('缺少必填字段 → 抛出 DatabaseError', () => {
      stmt.all.mockReturnValueOnce([{
        id: 'm1', thread_id: 't1', role: 'agent', content: 'test',
        // 缺少 adapter_name / status / created_at / token_count
      }])

      expect(() => repo.listMessages('t1')).toThrow('Missing required field')
    })
  })
})
