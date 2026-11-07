/**
 * S1 迁移状态机（session-map 蓝图 §8.14 / §8.14.1）
 *
 * 所有迁移阶段记录复用 `map_migration_reports`（不新增表）。语义：
 *  - started：阶段开始前先提交一行 `running`（owner_pid 必填，started_at=heartbeat_at）；
 *  - ok：阶段事务提交且校验通过（finished_at + stats_json 必填）；
 *  - partial：仅限声明为可续跑的阶段只完成一部分（details_json.resume_from）；
 *  - failed：校验失败/异常/不可续跑阶段中断（error_json + finished_at），启动阻断。
 *
 * 硬规则：
 *  1. 半迁移拒绝启动：running 且心跳超过 10 分钟或 owner_pid 已死 → 拒绝启动，
 *     只允许显式 `--resume-migration` 进入续跑模式；
 *  2. 并发迁移互斥：owner_pid 是其他存活进程 → 拒绝启动；
 *  3. 孤儿 `*_backup` / `*_new` 表 → 按 §8.14.1 五场景判定，歧义即拒绝，
 *     不自动删除任何一张；
 *  4. 只有幂等操作（addColumnSafe / 回填 / CREATE INDEX）允许续跑；
 *  5. 不静默清理：任何 backup 表删除都必须有报告与显式动作。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('MapMigration')

/** 心跳间隔（毫秒）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** 心跳超过该时长未更新视为"半迁移"（§8.14.1）。 */
export const HEARTBEAT_STALE_MS = 10 * 60_000

/**
 * 可自动续跑/idempotent 阶段白名单（§8.14.1 B1）。半迁移与失败重试只允许这些
 * 阶段自动进行：它们每次启动都会重跑，且操作幂等（回填/建索引/addColumnSafe）。
 * 非白名单阶段仍阻断启动——重试无法证明安全。
 */
const RESUMABLE_STAGES = new Set([
  'S1.backfill',
  'S1.report',
  'S1.verify',
  'S2',
  'S2.tables',
  'S2.backfill',
  'S6a.verify',
])

export type MapMigrationStageStatus = 'running' | 'ok' | 'partial' | 'failed'

/** kind 值域与 map_migration_reports 的 CHECK 一致。 */
export type MapMigrationKind =
  | 'entity_key_backfill'
  | 'link_backfill'
  | 'integrity_check'
  | 'import_dedup'
  | 'derivation'
  | 'cleanup'

export interface MapMigrationReportRow {
  id: string
  kind: MapMigrationKind
  stage: string | null
  schema_version: number | null
  started_at: string
  finished_at: string | null
  heartbeat_at: string | null
  owner_pid: number | null
  status: MapMigrationStageStatus
  stats_json: string | null
  details_json: string | null
  error_json: string | null
}

/** 启动预检失败——携带面向用户的处置提示；调用方必须拒绝启动，不得降级只读。 */
export class MapMigrationBlockedError extends Error {
  constructor(
    /** 机器可读原因：preflight 断言/日志用。 */
    public readonly reason:
      | 'integrity_check_failed'
      | 'foreign_key_violations'
      | 'stage_failed'
      | 'another_instance_migrating'
      | 'half_migration'
      | 'partial_not_resumable'
      | 'orphan_backup_ambiguous',
    message: string,
  ) {
    super(message)
    this.name = 'MapMigrationBlockedError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = 进程不存在；EPERM 等 = 进程存在但无权发信号（如系统进程）——都算存活。
    const code = (err as NodeJS.ErrnoException)?.code
    return code !== 'ESRCH'
  }
}

/** `--resume-migration` 显式续跑模式（§8.14.1 启动预检第 3 步的唯一旁路）。 */
export function isResumeMigrationRequested(argv: string[] = process.argv): boolean {
  return argv.includes('--resume-migration')
}

/** 报告行 id 的进程内单调计数：同毫秒多次 startStage 时保证 `id DESC` 排序稳定。 */
let reportIdSeq = 0

export class MapMigrationStore {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private tableReady(): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_migration_reports'")
      .get()
    return row != null
  }

  /** 阶段开始：先提交一行 running。返回报告行 id（供 heartbeat/complete 引用）。 */
  startStage(input: { kind: MapMigrationKind; stage: string; schemaVersion: number }): string {
    const id = `mmr_${Date.now()}_${(reportIdSeq++).toString(36).padStart(4, '0')}`
    const now = nowIso()
    this.db
      .prepare(
        `INSERT INTO map_migration_reports
           (id, kind, stage, schema_version, started_at, heartbeat_at, owner_pid, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(id, input.kind, input.stage, input.schemaVersion, now, now, process.pid)
    return id
  }

  /** 心跳：只更新仍为 running 的行；写失败不阻断阶段（§8.14.1），由调用方记 warn。 */
  heartbeat(id: string): void {
    try {
      this.db
        .prepare("UPDATE map_migration_reports SET heartbeat_at = ? WHERE id = ? AND status = 'running'")
        .run(nowIso(), id)
    } catch (err) {
      logger.warn(`heartbeat write failed for ${id}:`, err)
    }
  }

  completeStage(
    id: string,
    status: 'ok' | 'partial' | 'failed',
    data?: { stats?: Record<string, unknown>; details?: Record<string, unknown>; error?: unknown },
  ): void {
    this.db
      .prepare(
        `UPDATE map_migration_reports
            SET status = ?, finished_at = ?, stats_json = ?, details_json = ?, error_json = ?
          WHERE id = ?`,
      )
      .run(
        status,
        nowIso(),
        data?.stats ? JSON.stringify(data.stats) : null,
        data?.details ? JSON.stringify(data.details) : null,
        data?.error != null
          ? JSON.stringify(data.error instanceof Error ? { message: data.error.message } : data.error)
          : null,
        id,
      )
  }

  /** 某阶段语义组的最新一行（kind+stage 精确匹配；started_at DESC, id DESC）。 */
  latestStage(kind: MapMigrationKind, stage: string): MapMigrationReportRow | undefined {
    if (!this.tableReady()) return undefined
    return this.db
      .prepare(
        `SELECT * FROM map_migration_reports
          WHERE kind = ? AND stage = ?
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
      )
      .get(kind, stage) as MapMigrationReportRow | undefined
  }

  /** 全表最新状态扫描（预检用）：每个 (kind, stage) 只看最新一行。 */
  latestByStage(): MapMigrationReportRow[] {
    if (!this.tableReady()) return []
    return this.db
      .prepare(
        `SELECT r.* FROM map_migration_reports r
          JOIN (
            SELECT kind, COALESCE(stage, '') AS stage_key, MAX(started_at || ':' || id) AS max_key
            FROM map_migration_reports GROUP BY kind, stage_key
          ) latest ON r.kind = latest.kind AND COALESCE(r.stage, '') = latest.stage_key
                  AND r.started_at || ':' || r.id = latest.max_key`,
      )
      .all() as MapMigrationReportRow[]
  }

  /** 孤儿备份表扫描（§8.14.1 五场景）。返回需要人工处置的现场描述；空数组 = 干净。 */
  scanOrphanBackupTables(): Array<{ scenario: string; tables: string[]; verdict: string; blocking: boolean }> {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%\\_backup' ESCAPE '\\' OR name LIKE '%\\_new' ESCAPE '\\')",
      )
      .all() as Array<{ name: string }>
    if (rows.length === 0) return []

    const names = rows.map((r) => r.name)
    const byBase = new Map<string, { backup?: string; neu?: string; original: boolean }>()
    for (const name of names) {
      const isBackup = name.endsWith('_backup')
      const isNew = name.endsWith('_new')
      const base = isBackup ? name.slice(0, -'_backup'.length) : isNew ? name.slice(0, -'_new'.length) : name
      const entry = byBase.get(base) ?? { original: this.hasTable(base) }
      if (isBackup) entry.backup = name
      if (isNew) entry.neu = name
      byBase.set(base, entry)
    }

    const findings: Array<{ scenario: string; tables: string[]; verdict: string; blocking: boolean }> = []
    for (const [base, entry] of byBase) {
      const tables = [entry.backup, entry.neu].filter((v): v is string => Boolean(v))
      if (entry.original && entry.backup && entry.neu) {
        findings.push({ scenario: `${base}: original+backup+new`, tables, verdict: '重建中断在 rename 前后,状态歧义;人工选择恢复/继续', blocking: true })
      } else if (!entry.original && entry.backup && entry.neu) {
        findings.push({ scenario: `${base}: backup+new 无原表`, tables, verdict: '原表可能已被 rename 走;先校验 backup 行数与 hash,人工恢复', blocking: true })
      } else if (entry.original && entry.backup && !entry.neu) {
        findings.push({ scenario: `${base}: original+backup`, tables, verdict: '可能是上次重建完成但未清理;原表校验通过可启动,不自动删 backup', blocking: false })
      } else if (!entry.original && entry.neu) {
        findings.push({ scenario: `${base}: 仅 new`, tables, verdict: '严重半迁移;不允许把 _new 当正式表', blocking: true })
      } else if (!entry.original && entry.backup) {
        findings.push({ scenario: `${base}: 仅 backup`, tables, verdict: '原表丢失;提示从 backup 恢复', blocking: true })
      }
    }
    return findings
  }

  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null
  }
}

/**
 * 启动预检（fail-closed，§8.14.1）。任何一步失败都抛 MapMigrationBlockedError，
 * 调用方必须拒绝启动——不得降级为只读继续跑业务。
 */
export function preflightStartup(
  db: BetterSqlite3.Database,
  store: MapMigrationStore,
  options: { resumeRequested?: boolean } = {},
): void {
  // 1. integrity_check
  const integrity = db.pragma('integrity_check', { simple: true })
  if (integrity !== 'ok') {
    throw new MapMigrationBlockedError(
      'integrity_check_failed',
      `数据库完整性校验失败（${String(integrity)}）。请恢复 S0 备份后重试。`,
    )
  }

  // 2. foreign_key_check
  const fkViolations = db.pragma('foreign_key_check') as unknown[]
  if (Array.isArray(fkViolations) && fkViolations.length > 0) {
    throw new MapMigrationBlockedError(
      'foreign_key_violations',
      `外键校验发现 ${fkViolations.length} 处悬空引用。请恢复备份后重试。`,
    )
  }

  // 3. 阶段最新状态
  const resumeRequested = options.resumeRequested ?? isResumeMigrationRequested()
  for (const row of store.latestByStage()) {
    const label = `${row.kind}/${row.stage ?? '-'}`
    const autoResumable = RESUMABLE_STAGES.has(row.stage ?? '')
    if (row.status === 'failed') {
      // 幂等阶段自动重试（这些阶段每次启动都会重跑）；非幂等阶段仍 fail-closed。
      if (autoResumable) {
        logger.warn(`阶段 ${label} 上次失败；该阶段幂等且每次启动重跑，本次自动重试`)
        continue
      }
      throw new MapMigrationBlockedError(
        'stage_failed',
        `上一次迁移阶段 ${label} 失败，且该阶段不是幂等可重试阶段。请恢复备份或人工修复后重试（详情见 map_migration_reports ${row.id}）。`,
      )
    }
    if (row.status === 'running') {
      const pidAlive = row.owner_pid != null && isPidAlive(row.owner_pid)
      const heartbeatAge = row.heartbeat_at ? Date.now() - new Date(row.heartbeat_at).getTime() : Infinity
      if (pidAlive && row.owner_pid !== process.pid) {
        throw new MapMigrationBlockedError(
          'another_instance_migrating',
          `另一实例（pid ${row.owner_pid}）正在执行迁移阶段 ${label}，本进程拒绝启动以避免双写。`,
        )
      }
      const stale = !pidAlive || heartbeatAge > HEARTBEAT_STALE_MS
      if (stale) {
        if (resumeRequested || autoResumable) {
          logger.warn(
            `${resumeRequested ? '--resume-migration' : '幂等白名单'}：自动续跑半迁移阶段 ${label}（仅幂等操作允许）`,
          )
        } else {
          throw new MapMigrationBlockedError(
            'half_migration',
            `上一次迁移未完成（${label}，心跳已停止），且该阶段不是幂等可重试阶段。请恢复备份后重试。`,
          )
        }
      }
    }
    if (row.status === 'partial') {
      // partial 只允许续跑声明为可续跑的阶段（§8.14.1 B1 阶段目录白名单）；
      // 不可续跑阶段一律拒绝，与是否显式 --resume-migration 无关。
      if (!autoResumable) {
        throw new MapMigrationBlockedError(
          'partial_not_resumable',
          `阶段 ${label} 处于 partial 且不可续跑。请恢复备份后重试。`,
        )
      }
      logger.info(`partial 阶段 ${label} 声明为可续跑，迁移执行器将自动续跑`)
    }
  }

  // 4. 孤儿 _backup / _new
  const findings = store.scanOrphanBackupTables()
  for (const f of findings) {
    if (f.blocking) {
      throw new MapMigrationBlockedError(
        'orphan_backup_ambiguous',
        `检测到中断的表重建现场（${f.scenario}）。不自动删除任何一张表，请人工处置：${f.verdict}`,
      )
    }
    logger.warn(`孤儿备份表（不阻断启动）：${f.scenario} — ${f.verdict}`)
  }
}

export interface MigrationStageOptions {
  kind: MapMigrationKind
  stage: string
  schemaVersion: number
  /**
   * 阶段工作体。抛错即 failed；返回 stats/details 由调用方写成 ok。
   * `partial=true` 表示可续跑阶段只完成一部分（如单项目回填失败）：调用方必须
   * 把失败现场写入 details，启动预检据此放行并自动续跑。
   */
  work: () => { stats?: Record<string, unknown>; details?: Record<string, unknown>; partial?: boolean } | void
}

/**
 * 阶段执行器：先提交 running 行，再执行工作，成功后更新 ok/partial。
 * 心跳每 30s 一次（§8.14.1）；崩溃后 running 行保留，由启动预检裁决。
 */
export function runMigrationStage(db: BetterSqlite3.Database, options: MigrationStageOptions): void {
  const store = new MapMigrationStore(db)
  const id = store.startStage({ kind: options.kind, stage: options.stage, schemaVersion: options.schemaVersion })
  const heartbeatTimer = setInterval(() => store.heartbeat(id), HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
  try {
    const result = options.work()
    const status = result?.partial ? 'partial' : 'ok'
    store.completeStage(id, status, { stats: result?.stats, details: result?.details })
    logger.info(`migration stage ${options.kind}/${options.stage} ${status}`, result?.stats ?? {})
  } catch (err) {
    store.completeStage(id, 'failed', { error: err })
    logger.error(`migration stage ${options.kind}/${options.stage} failed:`, err)
    throw err
  } finally {
    clearInterval(heartbeatTimer)
  }
}

/** 每个 (kind, stage) 保留的报告行数上限（见 pruneMapMigrationReports）。 */
export const REPORT_RETENTION_PER_STAGE = 20

/**
 * 裁剪 `map_migration_reports` 的无界增长（启动与每日任务都会追加行）。
 *
 * 保留策略按 (kind, stage) 分组而非按时间：启动预检只读每组的**最新**一行
 * （latestByStage），因此删除更早的同组行不会改变任何预检结论。
 * `running` 行一律保留——那是半迁移现场，不能被裁剪掩盖。
 *
 * 有删除时追加一行 kind='cleanup' 的可查询记录，不做静默清理。
 */
export function pruneMapMigrationReports(
  db: BetterSqlite3.Database,
  keepPerStage = REPORT_RETENTION_PER_STAGE,
): { deleted: number } {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='map_migration_reports'")
    .get()
  if (!tableExists) return { deleted: 0 }

  const keep = Number.isInteger(keepPerStage) && keepPerStage > 0 ? keepPerStage : REPORT_RETENTION_PER_STAGE

  const result = db
    .prepare(
      `DELETE FROM map_migration_reports
        WHERE status <> 'running'
          AND id IN (
            SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY kind, COALESCE(stage, '')
                       ORDER BY started_at DESC, id DESC
                     ) AS rn
              FROM map_migration_reports
              WHERE status <> 'running'
            )
            WHERE rn > ?
          )`,
    )
    .run(keep)

  const deleted = Number(result.changes ?? 0)
  if (deleted > 0) {
    const id = `mmr_${Date.now()}_${(reportIdSeq++).toString(36).padStart(4, '0')}`
    const now = nowIso()
    try {
      db.prepare(
        `INSERT INTO map_migration_reports
           (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json)
         VALUES (?, 'cleanup', 'reports', NULL, ?, ?, ?, 'ok', ?)`,
      ).run(id, now, now, process.pid, JSON.stringify({ deleted, keep_per_stage: keep }))
    } catch (err) {
      logger.warn('failed to record map_migration_reports cleanup:', err)
    }
  }

  logger.info(`map_migration_reports pruned: deleted=${deleted}, keep_per_stage=${keep}`)
  return { deleted }
}

