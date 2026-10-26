/**
 * A2A 任务的 chat_threads 持久化
 *
 * task-store 的文档承诺「任务持久化到 chat_threads，server restart 时把
 * working 收敛为 failed」，但此前只有内存实现 —— 重启后 GET /v1/tasks/:id
 * 一律 404，working 的任务也永远不会被收敛。
 *
 * A2A 任务复用 chat_threads 表，用 metadata.task_kind='a2a' 与本地会话线程
 * 区分（数据库已有 idx_chat_threads_task_kind 表达式索引）。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type {
  A2AArtifact,
  A2AMessage,
  A2AStatusState,
  A2ATaskRecord,
} from '@shared/types/a2a'
import type { A2ATaskPersistence } from './task-store'

interface A2ATaskMetadata {
  task_kind: 'a2a'
  contextId: string
  sessionId: string
  status: A2AStatusState
  artifacts: A2AArtifact[]
  history: A2AMessage[]
  startedAt: number
  lastActivityAt: number
}

/**
 * A2A 状态 → chat_threads.status。
 *
 * chat_threads.status 有 CHECK 约束（idle/running/error/reviewed/active/archived），
 * A2A 的五个状态要落到其中之一；权威的 A2A 状态另存在 metadata.status。
 */
const THREAD_STATUS: Record<A2AStatusState, string> = {
  working: 'running',
  'input-required': 'running',
  completed: 'active',
  failed: 'error',
  canceled: 'archived',
}

function parseMetadata(raw: unknown): A2ATaskMetadata | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw) as Partial<A2ATaskMetadata>
    if (parsed.task_kind !== 'a2a') return null
    if (typeof parsed.contextId !== 'string') return null
    return {
      task_kind: 'a2a',
      contextId: parsed.contextId,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      status: parsed.status ?? 'failed',
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      lastActivityAt: typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : 0,
    }
  } catch {
    return null
  }
}

/** chat_threads 持久化实现。写失败不影响内存态 —— task-store 是运行时权威。 */
export class ChatThreadsTaskPersistence implements A2ATaskPersistence {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /** 新建或覆盖一条 A2A 任务记录。 */
  upsert(record: A2ATaskRecord): void {
    const metadata: A2ATaskMetadata = {
      task_kind: 'a2a',
      contextId: record.contextId,
      sessionId: record.sessionId,
      status: record.status,
      artifacts: record.artifacts,
      history: record.history,
      startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt,
    }
    this.db.prepare(
      `INSERT INTO chat_threads
         (id, title, adapter_name, session_id, status, created_at, updated_at, metadata)
       VALUES (?, ?, 'a2a', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         session_id = excluded.session_id,
         updated_at = excluded.updated_at,
         metadata = excluded.metadata`,
    ).run(
      record.taskId,
      `A2A ${record.contextId}`,
      record.sessionId,
      THREAD_STATUS[record.status],
      record.startedAt,
      record.lastActivityAt,
      JSON.stringify(metadata),
    )
  }

  /** 状态 / artifact / history 变化后的落库。 */
  update(record: A2ATaskRecord): void {
    this.upsert(record)
  }

  delete(taskId: string): void {
    this.db.prepare('DELETE FROM chat_threads WHERE id = ? AND json_extract(metadata, \'$.task_kind\') = \'a2a\'').run(taskId)
  }

  /** 读取全部 A2A 任务（按更新时间倒序）。 */
  listAll(): A2ATaskRecord[] {
    const rows = this.db.prepare(
      `SELECT id, session_id, metadata, created_at, updated_at
         FROM chat_threads
        WHERE json_extract(metadata, '$.task_kind') = 'a2a'
        ORDER BY updated_at DESC`,
    ).all() as Array<Record<string, unknown>>
    const out: A2ATaskRecord[] = []
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata)
      if (metadata === null) continue
      out.push({
        taskId: String(row.id),
        contextId: metadata.contextId,
        sessionId: typeof row.session_id === 'string' ? row.session_id : metadata.sessionId,
        status: metadata.status,
        startedAt: typeof row.created_at === 'number' ? row.created_at : metadata.startedAt,
        lastActivityAt: typeof row.updated_at === 'number' ? row.updated_at : metadata.lastActivityAt,
        artifacts: metadata.artifacts,
        history: metadata.history,
      })
    }
    return out
  }

  find(taskId: string): A2ATaskRecord | null {
    const row = this.db.prepare(
      `SELECT id, session_id, metadata, created_at, updated_at
         FROM chat_threads
        WHERE id = ? AND json_extract(metadata, '$.task_kind') = 'a2a'`,
    ).get(taskId) as Record<string, unknown> | undefined
    if (!row) return null
    const metadata = parseMetadata(row.metadata)
    if (metadata === null) return null
    return {
      taskId: String(row.id),
      contextId: metadata.contextId,
      sessionId: typeof row.session_id === 'string' ? row.session_id : metadata.sessionId,
      status: metadata.status,
      startedAt: typeof row.created_at === 'number' ? row.created_at : metadata.startedAt,
      lastActivityAt: typeof row.updated_at === 'number' ? row.updated_at : metadata.lastActivityAt,
      artifacts: metadata.artifacts,
      history: metadata.history,
    }
  }
}

/**
 * 构造 chat_threads 持久化实现。
 *
 * 数据库尚未就绪时返回 null —— A2A server 仍可用，只是任务不落库
 * （A2A server 可能在 DB 初始化前被拉起）。
 */
export async function createTaskPersistence(): Promise<A2ATaskPersistence | null> {
  try {
    const { getClient } = await import('../database')
    return new ChatThreadsTaskPersistence(getClient())
  } catch {
    return null
  }
}
