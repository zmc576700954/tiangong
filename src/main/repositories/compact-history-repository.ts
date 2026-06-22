/**
 * CompactHistoryRepository
 * 持久化 compact_history 表。Phase 1 落地骨架，Phase 3 起被 AgentManager.compactContext 使用。
 */

import type { Client, Row } from '@libsql/client'
import { generateId } from '../shared/env'
import type {
  CompactHistoryEntry,
  CompactStrategy,
  CompactTrigger,
} from '@shared/types'

export interface CompactHistoryInsert {
  threadId: string | null
  sessionId: string | null
  strategy: CompactStrategy
  trigger: CompactTrigger
  tokensBefore: number
  tokensAfter: number
  summary: string | null
  startedAt: number
  durationMs: number
}

function toEntry(row: Row): CompactHistoryEntry {
  return {
    id: String(row.id ?? ''),
    threadId: row.thread_id != null ? String(row.thread_id) : null,
    sessionId: row.session_id != null ? String(row.session_id) : null,
    strategy: String(row.strategy ?? 'summary') as CompactStrategy,
    trigger: String(row.trigger ?? 'manual') as CompactTrigger,
    tokensBefore: Number(row.tokens_before ?? 0),
    tokensAfter: Number(row.tokens_after ?? 0),
    summary: row.summary != null ? String(row.summary) : null,
    startedAt: Number(row.started_at ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
  }
}

export class CompactHistoryRepository {
  constructor(private db: Client) {}

  /** Insert a compaction record. Returns the generated id. */
  async insert(data: CompactHistoryInsert): Promise<string> {
    const id = generateId('compact')
    await this.db.execute({
      sql: `INSERT INTO compact_history (
              id, thread_id, session_id, strategy, trigger,
              tokens_before, tokens_after, summary,
              started_at, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        data.threadId,
        data.sessionId,
        data.strategy,
        data.trigger,
        data.tokensBefore,
        data.tokensAfter,
        data.summary,
        data.startedAt,
        data.durationMs,
      ],
    })
    return id
  }

  /** List recent compactions for a thread, newest first. Default limit 50. */
  async listByThread(threadId: string, limit = 50): Promise<CompactHistoryEntry[]> {
    const result = await this.db.execute({
      sql: `SELECT id, thread_id, session_id, strategy, trigger,
                   tokens_before, tokens_after, summary,
                   started_at, duration_ms
            FROM compact_history
            WHERE thread_id = ?
            ORDER BY started_at DESC
            LIMIT ?`,
      args: [threadId, limit],
    })
    return result.rows.map(toEntry)
  }
}
