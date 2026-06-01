/**
 * Chat Repository
 * 负责 chat_threads 和 chat_messages 的 CRUD 操作
 */

import type { Client } from '@libsql/client'

export interface ChatThreadRow {
  id: string
  title: string
  adapter_name: string
  node_id: string | null
  graph_id: string | null
  session_id: string | null
  status: string
  created_at: number
  updated_at: number
}

export interface ChatMessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  adapter_name: string
  status: string
  error: string | null
  session_id: string | null
  context_refs: string | null
  tool_calls: string | null
  created_at: number
}

export class ChatRepository {
  constructor(private db: Client) {}

  // ==================== Thread CRUD ====================

  async createThread(data: {
    id: string
    title: string
    adapterName: string
    nodeId?: string
    graphId?: string
    sessionId?: string
  }): Promise<ChatThreadRow> {
    const now = Date.now()
    await this.db.execute({
      sql: `INSERT INTO chat_threads (id, title, adapter_name, node_id, graph_id, session_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [data.id, data.title, data.adapterName, data.nodeId ?? null, data.graphId ?? null, data.sessionId ?? null, now, now],
    })
    return {
      id: data.id,
      title: data.title,
      adapter_name: data.adapterName,
      node_id: data.nodeId ?? null,
      graph_id: data.graphId ?? null,
      session_id: data.sessionId ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    }
  }

  async getThread(id: string): Promise<ChatThreadRow | null> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM chat_threads WHERE id = ?',
      args: [id],
    })
    return (result.rows[0] as unknown as ChatThreadRow) ?? null
  }

  async listThreads(filters?: { nodeId?: string; graphId?: string; status?: string }): Promise<ChatThreadRow[]> {
    let sql = 'SELECT * FROM chat_threads WHERE 1=1'
    const args: unknown[] = []

    if (filters?.nodeId) {
      sql += ' AND node_id = ?'
      args.push(filters.nodeId)
    }
    if (filters?.graphId) {
      sql += ' AND graph_id = ?'
      args.push(filters.graphId)
    }
    if (filters?.status) {
      sql += ' AND status = ?'
      args.push(filters.status)
    }

    sql += ' ORDER BY updated_at DESC'
    const result = await this.db.execute({ sql, args })
    return result.rows as unknown as ChatThreadRow[]
  }

  async updateThread(id: string, data: { title?: string; status?: string; sessionId?: string; updatedAt?: number }): Promise<void> {
    const sets: string[] = []
    const args: unknown[] = []

    if (data.title !== undefined) { sets.push('title = ?'); args.push(data.title) }
    if (data.status !== undefined) { sets.push('status = ?'); args.push(data.status) }
    if (data.sessionId !== undefined) { sets.push('session_id = ?'); args.push(data.sessionId) }
    if (data.updatedAt !== undefined) { sets.push('updated_at = ?'); args.push(data.updatedAt) }

    if (sets.length === 0) return

    args.push(id)
    await this.db.execute({
      sql: `UPDATE chat_threads SET ${sets.join(', ')} WHERE id = ?`,
      args,
    })
  }

  async deleteThread(id: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM chat_messages WHERE thread_id = ?', args: [id] })
    await this.db.execute({ sql: 'DELETE FROM chat_threads WHERE id = ?', args: [id] })
  }

  async searchThreads(query: string): Promise<ChatThreadRow[]> {
    const like = `%${query}%`
    const result = await this.db.execute({
      sql: `SELECT DISTINCT t.* FROM chat_threads t
            LEFT JOIN chat_messages m ON m.thread_id = t.id
            WHERE t.title LIKE ? OR m.content LIKE ?
            ORDER BY t.updated_at DESC`,
      args: [like, like],
    })
    return result.rows as unknown as ChatThreadRow[]
  }

  // ==================== Message CRUD ====================

  async saveMessage(data: {
    id: string
    threadId: string
    role: string
    content: string
    adapterName: string
    status: string
    error?: string
    sessionId?: string
    contextRefs?: string
    toolCalls?: string
    createdAt: number
  }): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO chat_messages
            (id, thread_id, role, content, adapter_name, status, error, session_id, context_refs, tool_calls, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.id, data.threadId, data.role, data.content, data.adapterName,
        data.status, data.error ?? null, data.sessionId ?? null,
        data.contextRefs ?? null, data.toolCalls ?? null, data.createdAt,
      ],
    })
  }

  async saveMessages(messages: Array<{
    id: string
    threadId: string
    role: string
    content: string
    adapterName: string
    status: string
    error?: string
    sessionId?: string
    contextRefs?: string
    toolCalls?: string
    createdAt: number
  }>): Promise<void> {
    for (const msg of messages) {
      await this.saveMessage(msg)
    }
  }

  async listMessages(threadId: string): Promise<ChatMessageRow[]> {
    const result = await this.db.execute({
      sql: 'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC',
      args: [threadId],
    })
    return result.rows as unknown as ChatMessageRow[]
  }

  async deleteMessagesByThread(threadId: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM chat_messages WHERE thread_id = ?', args: [threadId] })
  }
}
