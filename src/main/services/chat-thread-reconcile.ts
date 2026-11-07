/**
 * 启动清扫：进程在"创建导入 thread 后、图事务提交前"崩溃留下的孤儿 thread。
 *
 * 判定（全部满足才删）：
 *   1. adapter_name = 'mindmap-internal'（仅思维导图导入流程创建的 thread）
 *   2. graph_id IS NULL（未关联任何图）
 *   3. status = 'running'（正常完成会置 idle，失败会置 error；running 只可能来自崩溃）
 *   4. created_at 早于 now - 阈值
 *
 * 阈值 24h 与 work_runs 的 queued 兜底一致：单次导入的生成阶段是分钟级，
 * 单机单实例下重启后不可能仍有 24 小时前的导入在进行；足够长的窗口也避免
 * 误删第二个实例正在使用的 thread。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('ChatThreadReconcile')

export const ORPHAN_IMPORT_THREAD_STALE_MS = 24 * 60 * 60 * 1000
export const IMPORT_THREAD_ADAPTER = 'mindmap-internal'

export interface OrphanThreadReconcileReport {
  deletedThreads: number
  deletedThreadIds: string[]
  staleMs: number
  cutoffMs: number
}

export function reconcileOrphanImportThreads(
  db: BetterSqlite3.Database,
  options?: { now?: number; staleMs?: number },
): OrphanThreadReconcileReport {
  const now = options?.now ?? Date.now()
  const staleMs =
    Number.isFinite(options?.staleMs) && (options?.staleMs as number) > 0
      ? (options?.staleMs as number)
      : ORPHAN_IMPORT_THREAD_STALE_MS
  const cutoff = now - staleMs

  const report: OrphanThreadReconcileReport = { deletedThreads: 0, deletedThreadIds: [], staleMs, cutoffMs: cutoff }

  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_threads'")
    .get()
  if (!table) return report

  const rows = db
    .prepare(
      `SELECT id FROM chat_threads
        WHERE adapter_name = ?
          AND graph_id IS NULL
          AND status = 'running'
          AND created_at < ?`,
    )
    .all(IMPORT_THREAD_ADAPTER, cutoff) as Array<{ id: string }>

  const ids = rows.map((r) => r.id)
  if (ids.length > 0) {
    const remove = db.transaction((threadIds: string[]) => {
      const delMessages = db.prepare('DELETE FROM chat_messages WHERE thread_id = ?')
      const delThread = db.prepare('DELETE FROM chat_threads WHERE id = ?')
      for (const id of threadIds) {
        delMessages.run(id)
        delThread.run(id)
      }
    })
    remove(ids)
    report.deletedThreads = ids.length
    report.deletedThreadIds = ids
  }

  // 可查询留痕（与 work_runs_reconcile 同一张表、同一 kind）。
  try {
    const startedAt = new Date(now).toISOString()
    db.prepare(
      `INSERT INTO map_migration_reports
         (id, kind, stage, started_at, finished_at, status, stats_json)
       VALUES (?, 'cleanup', 'chat_threads_orphan', ?, ?, 'ok', ?)`,
    ).run(`mmr_${now}_orphan_threads`, startedAt, startedAt, JSON.stringify(report))
  } catch (err) {
    logger.warn('Failed to record orphan thread reconcile report:', err)
  }

  if (ids.length > 0) {
    logger.info(`Reclaimed ${ids.length} orphan import thread(s) older than ${Math.round(staleMs / 3600000)}h`)
  }
  return report
}
