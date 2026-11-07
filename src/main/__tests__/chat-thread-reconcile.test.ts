/**
 * 启动清扫孤儿导入 thread：只清 mindmap-internal + 无 graph + running + 超过阈值。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type BetterSqlite3 from 'better-sqlite3'
import {
  reconcileOrphanImportThreads,
  IMPORT_THREAD_ADAPTER,
  ORPHAN_IMPORT_THREAD_STALE_MS,
} from '../services/chat-thread-reconcile'

const NOW = Date.UTC(2026, 0, 2)
const HOUR = 60 * 60 * 1000

function setupDb(): BetterSqlite3.Database {
  const db = new Database(':memory:') as unknown as BetterSqlite3.Database
  db.exec(`
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      graph_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      content TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE map_migration_reports (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, stage TEXT, schema_version INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT, owner_pid INTEGER,
      status TEXT NOT NULL, stats_json TEXT, details_json TEXT, error_json TEXT
    );
  `)
  return db
}

describe('reconcileOrphanImportThreads', () => {
  let db: BetterSqlite3.Database

  beforeEach(() => {
    db = setupDb()
  })

  afterEach(() => db.close())

  function insertThread(
    id: string,
    opts: { adapter?: string; graphId?: string | null; status?: string; ageMs?: number } = {},
  ): void {
    const created = NOW - (opts.ageMs ?? ORPHAN_IMPORT_THREAD_STALE_MS + HOUR)
    db.prepare(
      'INSERT INTO chat_threads (id, title, adapter_name, graph_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, id, opts.adapter ?? IMPORT_THREAD_ADAPTER, opts.graphId ?? null, opts.status ?? 'running', created, created)
    db.prepare('INSERT INTO chat_messages (id, thread_id, content, created_at) VALUES (?, ?, ?, ?)').run(
      `m_${id}`, id, '生成思维导图中…', created,
    )
  }

  function remaining(): string[] {
    return (db.prepare('SELECT id FROM chat_threads ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)
  }

  it('只删崩溃残留：mindmap-internal + 无 graph + running + 超 24h', () => {
    insertThread('orphan')
    insertThread('recent', { ageMs: HOUR })
    insertThread('success', { status: 'idle' })
    insertThread('failed', { status: 'error' })
    insertThread('user-chat', { adapter: 'claude' })
    insertThread('with-graph', { graphId: 'g1' })

    const report = reconcileOrphanImportThreads(db, { now: NOW })

    expect(remaining()).toEqual(['failed', 'recent', 'success', 'user-chat', 'with-graph'])
    expect(report.deletedThreads).toBe(1)
    expect(report.deletedThreadIds).toEqual(['orphan'])
    expect(report.staleMs).toBe(ORPHAN_IMPORT_THREAD_STALE_MS)
    // 消息随 thread 一起删除
    expect((db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id='orphan'").get() as { n: number }).n).toBe(0)
  })

  it('写入可查询的 cleanup 留痕（stage=chat_threads_orphan）', () => {
    insertThread('orphan')
    reconcileOrphanImportThreads(db, { now: NOW })

    const row = db
      .prepare("SELECT kind, stage, status, stats_json FROM map_migration_reports WHERE stage='chat_threads_orphan'")
      .get() as { kind: string; stage: string; status: string; stats_json: string }
    expect(row.kind).toBe('cleanup')
    expect(row.status).toBe('ok')
    const stats = JSON.parse(row.stats_json) as { deletedThreads: number; cutoffMs: number }
    expect(stats.deletedThreads).toBe(1)
    expect(stats.cutoffMs).toBe(NOW - ORPHAN_IMPORT_THREAD_STALE_MS)
  })

  it('无可清理对象时也留一条 deletedThreads=0 的报告', () => {
    insertThread('recent', { ageMs: HOUR })
    const report = reconcileOrphanImportThreads(db, { now: NOW })
    expect(report.deletedThreads).toBe(0)
    const row = db.prepare("SELECT stats_json FROM map_migration_reports WHERE stage='chat_threads_orphan'").get() as { stats_json: string }
    expect((JSON.parse(row.stats_json) as { deletedThreads: number }).deletedThreads).toBe(0)
  })
})
