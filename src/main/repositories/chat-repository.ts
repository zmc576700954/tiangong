/**
 * Chat Repository
 * 负责 chat_threads 和 chat_messages 的 CRUD 操作
 */

import type { Client, Row } from '@libsql/client'
import { DatabaseError, ErrorCode } from '../errors'

const THREAD_COLUMNS = [
  'id', 'title', 'adapter_name', 'node_id', 'graph_id', 'session_id',
  'status', 'created_at', 'updated_at', 'parent_thread_id',
  'context_tokens_used', 'context_window_max', 'last_compacted_at',
] as const

const MESSAGE_COLUMNS = [
  'id', 'thread_id', 'role', 'content', 'adapter_name', 'status', 'error',
  'session_id', 'context_refs', 'tool_calls', 'created_at', 'token_count',
] as const

const THREAD_SELECT = THREAD_COLUMNS.join(', ')
const MESSAGE_SELECT = MESSAGE_COLUMNS.join(', ')
const THREAD_PREFIXED = THREAD_COLUMNS.map(c => `t.${c}`).join(', ')

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
  parent_thread_id: string | null
  context_tokens_used: number
  context_window_max: number
  last_compacted_at: number | null
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
  token_count: number
}

/** Runtime type guard for ChatThreadRow */
export function isChatThreadRow(row: unknown): row is ChatThreadRow {
  return typeof row === 'object' && row !== null && 'id' in row && 'title' in row && 'status' in row
}

function requireString(row: Row, field: string): string {
  const value = row[field]
  if (value === undefined || value === null || value === '') {
    throw new DatabaseError(`Missing required field: ${field}`, ErrorCode.DB_QUERY_FAILED)
  }
  return String(value)
}

function requireNumber(row: Row, field: string): number {
  const value = row[field]
  if (value === undefined || value === null || value === '') {
    throw new DatabaseError(`Missing required field: ${field}`, ErrorCode.DB_QUERY_FAILED)
  }
  const num = Number(value)
  if (Number.isNaN(num)) {
    throw new DatabaseError(`Invalid numeric field: ${field}`, ErrorCode.DB_QUERY_FAILED)
  }
  return num
}

/** Cast a libsql Row to a ChatThreadRow with runtime field validation */
function toChatThreadRow(row: Row): ChatThreadRow {
  return {
    id: requireString(row, 'id'),
    title: requireString(row, 'title'),
    adapter_name: requireString(row, 'adapter_name'),
    node_id: row.node_id != null ? String(row.node_id) : null,
    graph_id: row.graph_id != null ? String(row.graph_id) : null,
    session_id: row.session_id != null ? String(row.session_id) : null,
    status: requireString(row, 'status'),
    created_at: requireNumber(row, 'created_at'),
    updated_at: requireNumber(row, 'updated_at'),
    parent_thread_id: row.parent_thread_id != null ? String(row.parent_thread_id) : null,
    context_tokens_used: requireNumber(row, 'context_tokens_used'),
    context_window_max: requireNumber(row, 'context_window_max'),
    last_compacted_at: row.last_compacted_at != null ? Number(row.last_compacted_at) : null,
  }
}

/** Cast a libsql Row to a ChatMessageRow with runtime field validation */
function toChatMessageRow(row: Row): ChatMessageRow {
  return {
    id: requireString(row, 'id'),
    thread_id: requireString(row, 'thread_id'),
    role: requireString(row, 'role'),
    content: requireString(row, 'content'),
    adapter_name: requireString(row, 'adapter_name'),
    status: requireString(row, 'status'),
    error: row.error != null ? String(row.error) : null,
    session_id: row.session_id != null ? String(row.session_id) : null,
    context_refs: row.context_refs != null ? String(row.context_refs) : null,
    tool_calls: row.tool_calls != null ? String(row.tool_calls) : null,
    created_at: requireNumber(row, 'created_at'),
    token_count: requireNumber(row, 'token_count'),
  }
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
      parent_thread_id: null,
      context_tokens_used: 0,
      context_window_max: 200000,
      last_compacted_at: null,
    }
  }

  async getThread(id: string): Promise<ChatThreadRow | null> {
    const result = await this.db.execute({
      sql: `SELECT ${THREAD_SELECT} FROM chat_threads WHERE id = ?`,
      args: [id],
    })
    return (result.rows[0] ? toChatThreadRow(result.rows[0]) : null)
  }

  async listThreads(filters?: { nodeId?: string; graphId?: string; status?: string }): Promise<ChatThreadRow[]> {
    let sql = `SELECT ${THREAD_SELECT} FROM chat_threads WHERE 1=1`
    const args: (string | null)[] = []

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
    return result.rows.map(toChatThreadRow)
  }

  async updateThread(id: string, data: { title?: string; status?: string; sessionId?: string; updatedAt?: number }): Promise<void> {
    const sets: string[] = []
    const args: (string | number | null)[] = []

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
    await this.db.batch([
      { sql: 'DELETE FROM chat_messages WHERE thread_id = ?', args: [id] },
      { sql: 'DELETE FROM chat_threads WHERE id = ?', args: [id] },
    ], 'write')
  }

  async searchThreads(query: string): Promise<ChatThreadRow[]> {
    // Escape SQL LIKE wildcards (% and _) with backslash; declare ESCAPE clause.
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const like = `%${escaped}%`
    const result = await this.db.execute({
      sql: `SELECT DISTINCT ${THREAD_PREFIXED} FROM chat_threads t
            LEFT JOIN chat_messages m ON m.thread_id = t.id
            WHERE t.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
            ORDER BY t.updated_at DESC`,
      args: [like, like],
    })
    return result.rows.map(toChatThreadRow)
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
    tokenCount?: number
  }): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO chat_messages
            (id, thread_id, role, content, adapter_name, status, error, session_id, context_refs, tool_calls, created_at, token_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.id, data.threadId, data.role, data.content, data.adapterName,
        data.status, data.error ?? null, data.sessionId ?? null,
        data.contextRefs ?? null, data.toolCalls ?? null, data.createdAt,
        data.tokenCount ?? 0,
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
    tokenCount?: number
  }>): Promise<void> {
    if (messages.length === 0) return
    const stmts = messages.map((msg) => ({
      sql: `INSERT OR REPLACE INTO chat_messages
            (id, thread_id, role, content, adapter_name, status, error, session_id, context_refs, tool_calls, created_at, token_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        msg.id, msg.threadId, msg.role, msg.content, msg.adapterName,
        msg.status, msg.error ?? null, msg.sessionId ?? null,
        msg.contextRefs ?? null, msg.toolCalls ?? null, msg.createdAt,
        msg.tokenCount ?? 0,
      ],
    }))
    await this.db.batch(stmts)
  }

  async listMessages(threadId: string, limit = 50, offset = 0): Promise<ChatMessageRow[]> {
    const result = await this.db.execute({
      sql: `SELECT ${MESSAGE_SELECT} FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      args: [threadId, limit, offset],
    })
    return result.rows.map(toChatMessageRow)
  }

  async deleteMessagesByThread(threadId: string): Promise<void> {
    await this.db.execute({ sql: 'DELETE FROM chat_messages WHERE thread_id = ?', args: [threadId] })
  }

  async archiveStaleThreads(projectId: string, cutoff: number): Promise<number> {
    const result = await this.db.execute({
      sql: `UPDATE chat_threads SET status = 'archived' WHERE graph_id = ? AND status != 'archived' AND updated_at < ?`,
      args: [projectId, cutoff],
    })
    return result.rowsAffected
  }

  /** Task 2.5.2: Delete archived threads older than the cutoff (90 days) */
  async cleanupArchivedThreads(cutoff: number): Promise<number> {
    const result = await this.db.execute({
      sql: `DELETE FROM chat_threads WHERE status = 'archived' AND updated_at < ?`,
      args: [cutoff],
    })
    return result.rowsAffected
  }

  // ==================== Context Waterline (Phase 2) ====================

  async setContextWindowMax(threadId: string, max: number): Promise<void> {
    await this.db.execute({
      sql: `UPDATE chat_threads SET context_window_max = ? WHERE id = ?`,
      args: [max, threadId],
    })
  }

  async setLastCompactedAt(threadId: string, timestamp: number): Promise<void> {
    await this.db.execute({
      sql: `UPDATE chat_threads SET last_compacted_at = ? WHERE id = ?`,
      args: [timestamp, threadId],
    })
  }

  async resetContextTokens(threadId: string, tokens: number): Promise<void> {
    await this.db.execute({
      sql: `UPDATE chat_threads SET context_tokens_used = ?, updated_at = ? WHERE id = ?`,
      args: [tokens, Date.now(), threadId],
    })
  }
}
