/**
 * MemoryHitService（G2-3 / II-05）
 *
 * `memory_hits` 的读写与保留治理：
 *  - 只插入不改写；幂等键 `(run_id, hit_kind, source_ref)`，重复写入返回既有行。
 *  - 只存引用（表:id），不存上下文/证据全文，不写用户原文与密钥（II-04 边界）。
 *  - 保留：180 天滚动删除；单项目上限 20 万行，超限删最旧（II-05 边界）。
 *
 * 写入方（G2-2 Layer1）在 run 终态后调用 `record`；本模块不调度扫描，
 * 启动/每日治理由 database.ts 调用 `pruneMemoryHits`。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'

/** 保留天数（II-05：180 天）。 */
export const MEMORY_HIT_RETENTION_DAYS = 180
/** 单项目行数上限（II-05：20 万行，超限按最旧滚动删除）。 */
export const MEMORY_HIT_PER_PROJECT_LIMIT = 200_000
/** 每 run 写入上限（II-04：最多 50 条 hit）。 */
export const MEMORY_HIT_PER_RUN_LIMIT = 50

export type MemoryHitKind = 'context' | 'step' | 'evidence' | 'deviation'

export interface MemoryHitRow {
  id: string
  project_path: string
  graph_id: string
  node_id: string | null
  work_item_id: string | null
  run_id: string
  step_id: string | null
  hit_kind: MemoryHitKind
  source_ref: string
  score: number
  created_at: string
}

export interface RecordMemoryHitInput {
  projectPath: string
  graphId: string
  nodeId?: string | null
  workItemId?: string | null
  runId: string
  stepId?: string | null
  hitKind: MemoryHitKind
  /** 稳定键 `表:id`（如 `node_evidence:ev_123`），必填。 */
  sourceRef: string
  /** 0–1，缺省 1.0。 */
  score?: number
  now?: Date
}

const HIT_KINDS: ReadonlySet<string> = new Set(['context', 'step', 'evidence', 'deviation'])

export class MemoryHitValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryHitValidationError'
  }
}

function requireText(value: string | null | undefined, field: string): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '') throw new MemoryHitValidationError(`memory_hits 缺 ${field}`)
  return trimmed
}

export class MemoryHitService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(id: string): MemoryHitRow | undefined {
    return this.db.prepare('SELECT * FROM memory_hits WHERE id = ?').get(id) as MemoryHitRow | undefined
  }

  listForRun(runId: string): MemoryHitRow[] {
    return this.db
      .prepare('SELECT * FROM memory_hits WHERE run_id = ? ORDER BY created_at ASC, id ASC')
      .all(runId) as MemoryHitRow[]
  }

  countForProject(projectPath: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memory_hits WHERE project_path = ?')
      .get(projectPath) as { n: number }
    return Number(row.n)
  }

  /** 幂等写入：重复键返回既有行（`reused=true`），不抛错、不覆盖。 */
  record(input: RecordMemoryHitInput): { row: MemoryHitRow; reused: boolean } {
    const projectPath = requireText(input.projectPath, 'project_path')
    const graphId = requireText(input.graphId, 'graph_id')
    const runId = requireText(input.runId, 'run_id')
    const sourceRef = requireText(input.sourceRef, 'source_ref')
    if (!HIT_KINDS.has(input.hitKind)) {
      throw new MemoryHitValidationError(`memory_hits 未知 hit_kind: ${String(input.hitKind)}`)
    }
    const score = input.score ?? 1
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new MemoryHitValidationError(`memory_hits score 必须落在 0–1：${String(input.score)}`)
    }

    const existing = this.db
      .prepare('SELECT * FROM memory_hits WHERE run_id = ? AND hit_kind = ? AND source_ref = ?')
      .get(runId, input.hitKind, sourceRef) as MemoryHitRow | undefined
    if (existing) return { row: existing, reused: true }

    const id = randomUUID()
    const createdAt = (input.now ?? new Date()).toISOString()
    this.db
      .prepare(
        `INSERT INTO memory_hits
           (id, project_path, graph_id, node_id, work_item_id, run_id, step_id,
            hit_kind, source_ref, score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, hit_kind, source_ref) DO NOTHING`,
      )
      .run(
        id,
        projectPath,
        graphId,
        input.nodeId ?? null,
        input.workItemId ?? null,
        runId,
        input.stepId ?? null,
        input.hitKind,
        sourceRef,
        score,
        createdAt,
      )

    // 并发/重入时 ON CONFLICT 可能让我们没插进去，统一回读一次。
    const row = this.db
      .prepare('SELECT * FROM memory_hits WHERE run_id = ? AND hit_kind = ? AND source_ref = ?')
      .get(runId, input.hitKind, sourceRef) as MemoryHitRow
    return { row, reused: row.id !== id }
  }
}

export interface PruneMemoryHitsResult {
  deletedExpired: number
  deletedOverflow: number
}

/**
 * 保留治理（启动 + 每日）：
 *  1. 删除 `created_at` 早于 180 天的行；
 *  2. 逐项目检查行数，超过 20 万删最旧的多余部分。
 * 失败由调用方告警，不阻断启动。
 */
export function pruneMemoryHits(
  db: BetterSqlite3.Database,
  options: { now?: Date; retentionDays?: number; perProjectLimit?: number } = {},
): PruneMemoryHitsResult {
  const now = options.now ?? new Date()
  const retentionDays = options.retentionDays ?? MEMORY_HIT_RETENTION_DAYS
  const perProjectLimit = options.perProjectLimit ?? MEMORY_HIT_PER_PROJECT_LIMIT
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const expired = db.prepare('DELETE FROM memory_hits WHERE created_at < ?').run(cutoff)

  let deletedOverflow = 0
  const projects = db.prepare('SELECT DISTINCT project_path FROM memory_hits').all() as Array<{ project_path: string }>
  for (const { project_path: projectPath } of projects) {
    const count = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_hits WHERE project_path = ?').get(projectPath) as { n: number }).n,
    )
    if (count <= perProjectLimit) continue
    const overflow = count - perProjectLimit
    const deleted = db
      .prepare(
        `DELETE FROM memory_hits
          WHERE id IN (
            SELECT id FROM memory_hits
             WHERE project_path = ?
             ORDER BY created_at ASC, id ASC
             LIMIT ?
          )`,
      )
      .run(projectPath, overflow)
    deletedOverflow += Number(deleted.changes)
  }

  return { deletedExpired: Number(expired.changes), deletedOverflow }
}
