import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChatRepository } from '../repositories/chat-repository'
import type { Client, Row, ResultSet } from '@libsql/client'

function createMockDb(): Client {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
  } as unknown as Client
}

function mockRows(rows: Record<string, unknown>[]): ResultSet {
  return { rows: rows as unknown as Row[], columns: [], rowsAffected: 0, lastInsertRowid: 0n }
}

describe('ChatRepository', () => {
  let db: Client
  let repo: ChatRepository

  beforeEach(() => {
    db = createMockDb()
    repo = new ChatRepository(db)
  })

  // ==================== Thread CRUD ====================
  describe('createThread', () => {
    it('插入线程并返回', async () => {
      const result = await repo.createThread({
        id: 't1',
        title: 'Test Thread',
        adapterName: 'claude-code',
        nodeId: 'n1',
        graphId: 'g1',
        sessionId: 's1',
      })

      expect(db.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO chat_threads'),
      }))
      expect(result.id).toBe('t1')
      expect(result.title).toBe('Test Thread')
      expect(result.adapter_name).toBe('claude-code')
      expect(result.node_id).toBe('n1')
      expect(result.status).toBe('active')
    })

    it('可选字段为 null', async () => {
      const result = await repo.createThread({
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
    it('找到线程 → 返回 ChatThreadRow', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 't1', title: 'Thread', adapter_name: 'claude-code',
        node_id: 'n1', graph_id: null, session_id: null,
        status: 'active', created_at: 1000, updated_at: 2000,
      }]))

      const thread = await repo.getThread('t1')
      expect(thread).not.toBeNull()
      expect(thread!.id).toBe('t1')
      expect(thread!.created_at).toBe(1000)
    })

    it('未找到 → null', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      const thread = await repo.getThread('unknown')
      expect(thread).toBeNull()
    })
  })

  describe('listThreads', () => {
    it('无过滤器 → 查询所有', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.listThreads()
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('WHERE 1=1')
      expect(call.sql).not.toContain('node_id = ?')
    })

    it('带 nodeId 过滤', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.listThreads({ nodeId: 'n1' })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('node_id = ?')
      expect(call.args).toContain('n1')
    })

    it('带 graphId 和 status 过滤', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.listThreads({ graphId: 'g1', status: 'active' })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('graph_id = ?')
      expect(call.sql).toContain('status = ?')
    })

    it('结果按 updated_at DESC 排序', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.listThreads()
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('ORDER BY updated_at DESC')
    })
  })

  describe('updateThread', () => {
    it('更新 title 和 status', async () => {
      await repo.updateThread('t1', { title: 'New Title', status: 'archived' })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('title = ?')
      expect(call.sql).toContain('status = ?')
      expect(call.args).toContain('New Title')
      expect(call.args).toContain('archived')
    })

    it('空更新 → 不执行 SQL', async () => {
      await repo.updateThread('t1', {})
      expect(db.execute).not.toHaveBeenCalled()
    })

    it('更新 sessionId', async () => {
      await repo.updateThread('t1', { sessionId: 'new-session' })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('session_id = ?')
    })
  })

  describe('deleteThread', () => {
    it('级联删除消息和线程', async () => {
      await repo.deleteThread('t1')
      expect(db.batch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ sql: expect.stringContaining('DELETE FROM chat_messages') }),
          expect.objectContaining({ sql: expect.stringContaining('DELETE FROM chat_threads') }),
        ]),
        'write',
      )
    })
  })

  describe('searchThreads', () => {
    it('LIKE 搜索转义特殊字符', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.searchThreads('100%')
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args[0]).toBe('%100[%]%')
    })

    it('下划线也被转义', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.searchThreads('a_b')
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.args[0]).toBe('%a[_]b%')
    })

    it('JOIN chat_messages 搜索', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.searchThreads('keyword')
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('LEFT JOIN chat_messages')
      expect(call.sql).toContain('m.content LIKE ?')
    })
  })

  // ==================== Message CRUD ====================
  describe('saveMessage', () => {
    it('INSERT OR REPLACE 单条消息', async () => {
      await repo.saveMessage({
        id: 'm1', threadId: 't1', role: 'user', content: 'hello',
        adapterName: 'claude-code', status: 'success', createdAt: 1000,
      })
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('INSERT OR REPLACE INTO chat_messages')
    })
  })

  describe('saveMessages', () => {
    it('批量保存使用 batch', async () => {
      const messages = [
        { id: 'm1', threadId: 't1', role: 'user', content: 'hello', adapterName: 'claude', status: 'success', createdAt: 1000 },
        { id: 'm2', threadId: 't1', role: 'agent', content: 'hi', adapterName: 'claude', status: 'success', createdAt: 1001 },
      ]
      await repo.saveMessages(messages)
      expect(db.batch).toHaveBeenCalled()
    })

    it('空数组 → 不执行', async () => {
      await repo.saveMessages([])
      expect(db.batch).not.toHaveBeenCalled()
    })
  })

  describe('listMessages', () => {
    it('按 created_at ASC 排序', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([]))
      await repo.listMessages('t1')
      const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call.sql).toContain('ORDER BY created_at ASC')
    })
  })

  describe('toChatMessageRow 字段处理', () => {
    it('null 字段正确处理', async () => {
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows([{
        id: 'm1', thread_id: 't1', role: 'agent', content: 'test',
        adapter_name: 'claude', status: 'success',
        error: null, session_id: null, context_refs: null, tool_calls: null,
        created_at: 1000,
      }]))

      const messages = await repo.listMessages('t1')
      expect(messages).toHaveLength(1)
      expect(messages[0].error).toBeNull()
      expect(messages[0].session_id).toBeNull()
      expect(messages[0].context_refs).toBeNull()
      expect(messages[0].tool_calls).toBeNull()
    })
  })
})
