/**
 * G2-16 离线校准（§5.7 / II-18）：用 `plan_deviations` 回看推导规则。
 *
 * 口径（已裁决）：
 *  - 触发：距上次报告新增 ≥ 20 个 run，或距上次报告满 2 周（取先到者）；
 *  - 样本 < 20 run **不出报告**（2 周触发同样受此约束，不足则只记日志跳过）；
 *  - 输出只是**报告**：写一行 `map_migration_reports(kind='calibration')`，
 *    不改任何阈值/权重、不改历史计划、不写 `plan_deviations`；
 *  - 报告纯聚合、可复算：同一批 `plan_deviations` 重新计算得到同一 `stats_json`。
 *
 * 未做的部分（蓝图 I.9.3）：
 *  - 不按 `file_domain` 分组（视图依赖 `change_sets`，且明细聚合成本未评估）；
 *  - §5.7 的「连续 3 批 > 1.5」不做批次连续性判定，只给单窗口信号；
 *  - 报告保留走 `pruneMapMigrationReports` 的「每 (kind,stage) 保留 20 行」，
 *    不是按 1 年时间保留。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('PlanCalibration')

/** 出报告所需的最小样本（II-18 边界）。 */
export const CALIBRATION_MIN_RUNS = 20
/** 第二触发条件：距上次报告满 2 周。 */
export const CALIBRATION_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000
/** 单窗口内最多聚合的偏差行数（防御异常大的历史窗口）。 */
export const CALIBRATION_MAX_WINDOW_ROWS = 5000

interface DeviationRow {
  derivation_version: string
  observed_rule_version: string
  task_type: string
  agent_type: string | null
  planned_file_count: number | null
  actual_file_count: number | null
  planned_subtask_count: number | null
  actual_subtask_count: number | null
  rework_count: number
  test_failures: number
  replan_count: number
  scope_violation: number
  boundary_changed: number
}

export interface CalibrationGroup {
  derivationVersion: string
  observedRuleVersion: string
  taskType: string
  agentType: string | null
  runCount: number
  /** 仅统计 planned/actual 同时非空的 run；分母不足时为 null。 */
  fileRatio: number | null
  subtaskRatio: number | null
  replanMedian: number
  reworkCount: number
  testFailures: number
  scopeViolationRate: number
  boundaryChangedRate: number
  /** §5.7 的两个参考信号（单窗口，不判连续批次）。 */
  signals: string[]
}

export interface CalibrationReport {
  windowStart: string
  windowEnd: string
  runCount: number
  minRuns: number
  groups: CalibrationGroup[]
}

export interface CalibrationRunResult {
  ran: boolean
  reason: string
  reportId?: string
  runCount?: number
}

function hasTable(db: BetterSqlite3.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function ratio(actual: number | null, planned: number | null): number | null {
  if (actual === null || planned === null || planned <= 0) return null
  return Number((actual / planned).toFixed(3))
}

/** 纯聚合：给定偏差行，产出可复算的报告主体。 */
export function aggregateCalibration(
  rows: DeviationRow[],
  windowStart: string,
  windowEnd: string,
): CalibrationReport {
  const groups = new Map<string, DeviationRow[]>()
  for (const row of rows) {
    const key = [
      row.derivation_version,
      row.observed_rule_version,
      row.task_type,
      row.agent_type ?? '',
    ].join('\u0000')
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  const output: CalibrationGroup[] = []
  for (const bucket of groups.values()) {
    const first = bucket[0]
    let plannedFiles = 0
    let actualFiles = 0
    let plannedSubtasks = 0
    let actualSubtasks = 0
    let fileSamples = 0
    let subtaskSamples = 0
    let reworkCount = 0
    let testFailures = 0
    let scopeViolations = 0
    let boundaryChanges = 0
    const replans: number[] = []

    for (const row of bucket) {
      if (row.planned_file_count !== null && row.actual_file_count !== null) {
        plannedFiles += row.planned_file_count
        actualFiles += row.actual_file_count
        fileSamples++
      }
      if (row.planned_subtask_count !== null && row.actual_subtask_count !== null) {
        plannedSubtasks += row.planned_subtask_count
        actualSubtasks += row.actual_subtask_count
        subtaskSamples++
      }
      reworkCount += row.rework_count
      testFailures += row.test_failures
      replans.push(row.replan_count)
      if (row.scope_violation) scopeViolations++
      if (row.boundary_changed) boundaryChanges++
    }

    const fileRatio = fileSamples > 0 ? ratio(actualFiles, plannedFiles) : null
    const subtaskRatio = subtaskSamples > 0 ? ratio(actualSubtasks, plannedSubtasks) : null
    const replanMedian = median(replans)
    const signals: string[] = []
    if (fileRatio !== null && fileRatio > 1.5) signals.push('file_growth_gt_1_5')
    if (replanMedian > 2) signals.push('replan_median_gt_2')

    output.push({
      derivationVersion: first.derivation_version,
      observedRuleVersion: first.observed_rule_version,
      taskType: first.task_type,
      agentType: first.agent_type,
      runCount: bucket.length,
      fileRatio,
      subtaskRatio,
      replanMedian,
      reworkCount,
      testFailures,
      scopeViolationRate: Number((scopeViolations / bucket.length).toFixed(3)),
      boundaryChangedRate: Number((boundaryChanges / bucket.length).toFixed(3)),
      signals,
    })
  }

  output.sort((a, b) => {
    if (a.runCount !== b.runCount) return b.runCount - a.runCount
    const left = `${a.derivationVersion}|${a.taskType}|${a.agentType ?? ''}`
    const right = `${b.derivationVersion}|${b.taskType}|${b.agentType ?? ''}`
    return left.localeCompare(right)
  })

  return {
    windowStart,
    windowEnd,
    runCount: rows.length,
    minRuns: CALIBRATION_MIN_RUNS,
    groups: output,
  }
}

interface LastReport {
  id: string
  started_at: string
  finished_at: string | null
}

/**
 * 检查触发条件并在满足时写一份校准报告。
 *
 * 本函数不抛异常给启动路径：结构缺失/查询失败时返回 `ran=false` 并记日志。
 */
export function maybeRunCalibration(
  db: BetterSqlite3.Database,
  now: Date = new Date(),
): CalibrationRunResult {
  if (!hasTable(db, 'plan_deviations') || !hasTable(db, 'map_migration_reports')) {
    return { ran: false, reason: 'table_missing' }
  }

  const last = db
    .prepare(
      `SELECT id, started_at, finished_at
         FROM map_migration_reports
        WHERE kind = 'calibration'
        ORDER BY started_at DESC, id DESC
        LIMIT 1`,
    )
    .get() as LastReport | undefined

  const nowMs = now.getTime()
  const sinceMs = last ? Date.parse(last.started_at) : 0
  const since = Number.isFinite(sinceMs) ? sinceMs : 0

  const counted = db
    .prepare('SELECT COUNT(*) AS n, MIN(computed_at) AS first_at FROM plan_deviations')
    .get() as { n: number; first_at: number | null }

  const pending = db
    .prepare('SELECT COUNT(*) AS n FROM plan_deviations WHERE computed_at > ?')
    .get(since) as { n: number }

  const elapsedFrom = last ? since : (counted.first_at ?? nowMs)
  const elapsed = nowMs - elapsedFrom
  const enoughRuns = pending.n >= CALIBRATION_MIN_RUNS
  const enoughTime = elapsed >= CALIBRATION_INTERVAL_MS

  if (!enoughRuns && !enoughTime) {
    return { ran: false, reason: 'trigger_not_met', runCount: pending.n }
  }

  if (pending.n < CALIBRATION_MIN_RUNS) {
    // 2 周触发但样本不足：II-18 明确「样本 < 20 run 不出报告」。
    logger.info(`calibration skipped: only ${pending.n} runs since last report (min ${CALIBRATION_MIN_RUNS})`)
    return { ran: false, reason: 'insufficient_sample', runCount: pending.n }
  }

  const rows = db
    .prepare(
      `SELECT derivation_version, observed_rule_version, task_type, agent_type,
              planned_file_count, actual_file_count,
              planned_subtask_count, actual_subtask_count,
              rework_count, test_failures, replan_count,
              scope_violation, boundary_changed
         FROM plan_deviations
        WHERE computed_at > ?
        ORDER BY computed_at ASC, id ASC
        LIMIT ?`,
    )
    .all(since, CALIBRATION_MAX_WINDOW_ROWS) as DeviationRow[]

  if (rows.length < CALIBRATION_MIN_RUNS) {
    return { ran: false, reason: 'insufficient_sample', runCount: rows.length }
  }

  const startedAt = now.toISOString()
  const windowStart = since > 0 ? new Date(since).toISOString() : (counted.first_at ? new Date(counted.first_at).toISOString() : startedAt)
  const report = aggregateCalibration(rows, windowStart, startedAt)

  const id = `cal_${nowMs}_${Math.random().toString(36).slice(2, 8)}`
  db.prepare(
    `INSERT INTO map_migration_reports
       (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, stats_json, details_json)
     VALUES (?, 'calibration', 'periodic', NULL, ?, ?, ?, 'ok', ?, NULL)`,
  ).run(
    id,
    startedAt,
    startedAt,
    process.pid,
    JSON.stringify({
      window_start: report.windowStart,
      window_end: report.windowEnd,
      run_count: report.runCount,
      min_runs: report.minRuns,
      groups: report.groups,
    }),
  )

  logger.info(`calibration report written: id=${id} runs=${rows.length} groups=${report.groups.length}`)
  return { ran: true, reason: 'ok', reportId: id, runCount: rows.length }
}
