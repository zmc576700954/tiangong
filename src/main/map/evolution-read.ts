/**
 * 进化层只读查询（G2-3 `memory_hits` / G2-4 `v_memory_attribution` / G2-16 校准报告）。
 *
 * 为什么单独一个模块：这三块数据此前只有写路径与迁移期审计，界面读不到，
 * I.9.3 里三条妥协的解除条件都写着「需要在界面查看时补只读 IPC」。这里把
 * 「查什么、怎么聚合」集中在主进程，IPC 层只做参数校验，渲染层不写 SQL。
 *
 * 口径边界（不当成能力扩展）：
 * - 全部是 SELECT；不建表、不改 schema、不触发任何派生/校准计算；
 * - `memory_hits` 与 `v_memory_attribution` 可能是老库（v44/v46 迁移未跑）——
 *   表/视图不存在时返回 `available:false`，不抛错、不静默伪装成空列表；
 * - 归因视图的 `sample_size` 阈值由视图 SQL 决定（当前 20），这里只读不重算；
 * - 校准报告是**只读快照**：`stats_json` 不可解析时保留报告行并标 `parseError`。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type {
  AttributionListResult,
  AttributionRowView,
  AttributionSummaryView,
  CalibrationGroupView,
  CalibrationReportListResult,
  CalibrationReportView,
  EvolutionQuery,
  MemoryHitCountView,
  MemoryHitKindView,
  MemoryHitListResult,
  MemoryHitView,
  SourceOutcomeView,
} from '@shared/types/evolution'

/** 单次列表默认/最大条数（防止界面一次拉全库）。 */
export const EVOLUTION_DEFAULT_LIMIT = 200
export const EVOLUTION_MAX_LIMIT = 1000

/**
 * 归因视图的样本阈值。与 `v_memory_attribution` 建视图 SQL 里的 `>= 20` 是同一个数，
 * 视图负责判定、这里只负责让界面能解释「为什么这条标了样本不足」。
 */
export const ATTRIBUTION_MIN_SAMPLE = 20

const HIT_KINDS: ReadonlySet<string> = new Set(['context', 'step', 'evidence', 'deviation'])
const OUTCOMES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'interrupted',
])

interface HitRow {
  id: string
  project_path: string
  graph_id: string
  node_id: string | null
  work_item_id: string | null
  run_id: string
  step_id: string | null
  hit_kind: string
  source_outcome: string | null
  source_ref: string
  score: number
  created_at: string
}

interface AttributionDbRow {
  run_id: string
  step_id: string | null
  graph_id: string
  adapter: string | null
  mode_id: string | null
  outcome: string | null
  hit_count: number
  evidence_level: number | null
  sample_size: number
  conclusion: string
}

interface ReportRow {
  id: string
  started_at: string
  finished_at: string | null
  status: string
  stats_json: string | null
}

function hasObject(db: BetterSqlite3.Database, name: string, type: 'table' | 'view'): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?")
    .get(type, name) as { name?: string } | undefined
  return Boolean(row?.name)
}

function clampLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return EVOLUTION_DEFAULT_LIMIT
  }
  return Math.min(Math.floor(limit), EVOLUTION_MAX_LIMIT)
}

function emptyHitResult(): MemoryHitListResult {
  return { available: false, rows: [], total: 0, byKind: [], byOutcome: [] }
}

/** 过滤条件只由白名单列拼装，值一律走占位符。 */
interface WhereClause {
  sql: string
  params: unknown[]
}

function buildHitWhere(query: EvolutionQuery): WhereClause {
  const conditions: string[] = []
  const params: unknown[] = []
  if (typeof query.projectPath === 'string' && query.projectPath !== '') {
    conditions.push('project_path = ?')
    params.push(query.projectPath)
  }
  if (typeof query.graphId === 'string' && query.graphId !== '') {
    conditions.push('graph_id = ?')
    params.push(query.graphId)
  }
  if (typeof query.runId === 'string' && query.runId !== '') {
    conditions.push('run_id = ?')
    params.push(query.runId)
  }
  if (typeof query.hitKind === 'string' && HIT_KINDS.has(query.hitKind)) {
    conditions.push('hit_kind = ?')
    params.push(query.hitKind)
  }
  return {
    sql: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

function toSourceOutcome(value: string | null): SourceOutcomeView | null {
  // 存量行为 null（v45 前），脏值也不透传给界面——统一按「未标注」处理。
  return value !== null && OUTCOMES.has(value) ? (value as SourceOutcomeView) : null
}

function toHitView(row: HitRow): MemoryHitView {
  return {
    id: row.id,
    projectPath: row.project_path,
    graphId: row.graph_id,
    nodeId: row.node_id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    stepId: row.step_id,
    hitKind: row.hit_kind as MemoryHitKindView,
    sourceOutcome: toSourceOutcome(row.source_outcome),
    sourceRef: row.source_ref,
    score: Number(row.score),
    createdAt: row.created_at,
  }
}

/** `memory_hits` 分页列表 + 两类计数（按 kind / 按终态）。 */
export function listMemoryHits(
  db: BetterSqlite3.Database,
  query: EvolutionQuery = {},
): MemoryHitListResult {
  if (!hasObject(db, 'memory_hits', 'table')) return emptyHitResult()

  const where = buildHitWhere(query)
  const limit = clampLimit(query.limit)

  const rows = db
    .prepare(
      `SELECT id, project_path, graph_id, node_id, work_item_id, run_id, step_id,
              hit_kind, source_outcome, source_ref, score, created_at
         FROM memory_hits${where.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...where.params, limit) as HitRow[]

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM memory_hits${where.sql}`)
    .get(...where.params) as { n: number }

  const byKind = db
    .prepare(
      `SELECT hit_kind AS key, COUNT(*) AS n FROM memory_hits${where.sql}
        GROUP BY hit_kind ORDER BY n DESC, key ASC`,
    )
    .all(...where.params) as Array<{ key: string; n: number }>

  // source_outcome 可空（v45 前存量行）：用 'unknown' 显式占位，不把 null 当 completed。
  const byOutcome = db
    .prepare(
      `SELECT COALESCE(source_outcome, 'unknown') AS key, COUNT(*) AS n
         FROM memory_hits${where.sql}
        GROUP BY COALESCE(source_outcome, 'unknown') ORDER BY n DESC, key ASC`,
    )
    .all(...where.params) as Array<{ key: string; n: number }>

  return {
    available: true,
    rows: rows.map(toHitView),
    total: Number(totalRow.n),
    byKind: byKind.map((row): MemoryHitCountView => ({ key: row.key, count: Number(row.n) })),
    byOutcome: byOutcome.map((row): MemoryHitCountView => ({ key: row.key, count: Number(row.n) })),
  }
}

function emptyAttributionResult(): AttributionListResult {
  return {
    available: false,
    rows: [],
    total: 0,
    summary: {
      totalRuns: 0,
      runsWithHit: 0,
      hitRate: null,
      byOutcome: [],
      minSample: ATTRIBUTION_MIN_SAMPLE,
      groupsOk: 0,
      groupsInsufficient: 0,
    },
  }
}

/** `v_memory_attribution` 列表 + 汇总（命中率、结论分布）。 */
export function listAttribution(
  db: BetterSqlite3.Database,
  query: EvolutionQuery = {},
): AttributionListResult {
  if (!hasObject(db, 'v_memory_attribution', 'view')) return emptyAttributionResult()

  const conditions: string[] = []
  const params: unknown[] = []
  if (typeof query.graphId === 'string' && query.graphId !== '') {
    conditions.push('graph_id = ?')
    params.push(query.graphId)
  }
  if (typeof query.adapter === 'string' && query.adapter !== '') {
    conditions.push('adapter = ?')
    params.push(query.adapter)
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const limit = clampLimit(query.limit)

  const rows = db
    .prepare(
      `SELECT run_id, step_id, graph_id, adapter, mode_id, outcome,
              hit_count, evidence_level, sample_size, conclusion
         FROM v_memory_attribution${where}
        ORDER BY graph_id ASC, run_id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as AttributionDbRow[]

  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN hit_count > 0 THEN 1 ELSE 0 END) AS with_hit,
              SUM(CASE WHEN conclusion = 'ok' THEN 1 ELSE 0 END) AS ok_runs,
              SUM(CASE WHEN conclusion = 'insufficient_sample' THEN 1 ELSE 0 END) AS thin_runs
         FROM v_memory_attribution${where}`,
    )
    .get(...params) as {
    total: number
    with_hit: number | null
    ok_runs: number | null
    thin_runs: number | null
  }

  const byOutcome = db
    .prepare(
      `SELECT COALESCE(outcome, 'unknown') AS key, COUNT(*) AS n
         FROM v_memory_attribution${where}
        GROUP BY COALESCE(outcome, 'unknown') ORDER BY n DESC, key ASC`,
    )
    .all(...params) as Array<{ key: string; n: number }>

  const total = Number(agg.total ?? 0)
  const runsWithHit = Number(agg.with_hit ?? 0)
  const groupsOk = Number(agg.ok_runs ?? 0)
  const groupsInsufficient = Number(agg.thin_runs ?? 0)

  const summary: AttributionSummaryView = {
    totalRuns: total,
    runsWithHit,
    hitRate: total > 0 ? Number((runsWithHit / total).toFixed(4)) : null,
    byOutcome: byOutcome.map((row) => ({ key: row.key, count: Number(row.n) })),
    minSample: ATTRIBUTION_MIN_SAMPLE,
    groupsOk,
    groupsInsufficient,
  }

  return {
    available: true,
    rows: rows.map((row): AttributionRowView => ({
      runId: row.run_id,
      stepId: row.step_id,
      graphId: row.graph_id,
      adapter: row.adapter,
      modeId: row.mode_id,
      outcome: (row.outcome as SourceOutcomeView | null) ?? null,
      hitCount: Number(row.hit_count),
      evidenceLevel: row.evidence_level === null ? null : Number(row.evidence_level),
      sampleSize: Number(row.sample_size),
      conclusion: row.conclusion === 'ok' ? 'ok' : 'insufficient_sample',
    })),
    total,
    summary,
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** `stats_json.groups` 逐项投影；字段缺失给安全默认，不因一行脏数据丢整份报告。 */
function toGroupView(raw: unknown): CalibrationGroupView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const item = raw as Record<string, unknown>
  const derivationVersion = asString(item.derivationVersion)
  const observedRuleVersion = asString(item.observedRuleVersion)
  const taskType = asString(item.taskType)
  if (!derivationVersion || !observedRuleVersion || !taskType) return null
  return {
    derivationVersion,
    observedRuleVersion,
    taskType,
    agentType: asString(item.agentType),
    runCount: asNumber(item.runCount) ?? 0,
    fileRatio: asNumber(item.fileRatio),
    subtaskRatio: asNumber(item.subtaskRatio),
    replanMedian: asNumber(item.replanMedian) ?? 0,
    reworkCount: asNumber(item.reworkCount) ?? 0,
    testFailures: asNumber(item.testFailures) ?? 0,
    scopeViolationRate: asNumber(item.scopeViolationRate) ?? 0,
    boundaryChangedRate: asNumber(item.boundaryChangedRate) ?? 0,
    signals: toStringArray(item.signals),
  }
}

/** 最近若干份校准报告（`kind='calibration'`，新→旧）。 */
export function listCalibrationReports(
  db: BetterSqlite3.Database,
  limit?: number,
): CalibrationReportListResult {
  if (!hasObject(db, 'map_migration_reports', 'table')) return { available: false, reports: [] }

  const rows = db
    .prepare(
      `SELECT id, started_at, finished_at, status, stats_json
         FROM map_migration_reports
        WHERE kind = 'calibration'
        ORDER BY started_at DESC, id DESC
        LIMIT ?`,
    )
    .all(clampLimit(limit)) as ReportRow[]

  const reports = rows.map((row): CalibrationReportView => {
    const base: CalibrationReportView = {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      windowStart: null,
      windowEnd: null,
      runCount: 0,
      minRuns: 0,
      groups: [],
      parseError: null,
    }
    if (row.stats_json === null || row.stats_json === '') {
      return { ...base, parseError: 'stats_json 为空' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.stats_json)
    } catch (error) {
      return {
        ...base,
        parseError: error instanceof Error ? error.message : String(error),
      }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...base, parseError: 'stats_json 不是对象' }
    }
    const stats = parsed as Record<string, unknown>
    const groupsRaw = Array.isArray(stats.groups) ? stats.groups : []
    return {
      ...base,
      windowStart: asString(stats.window_start),
      windowEnd: asString(stats.window_end),
      runCount: asNumber(stats.run_count) ?? 0,
      minRuns: asNumber(stats.min_runs) ?? 0,
      groups: groupsRaw
        .map(toGroupView)
        .filter((group): group is CalibrationGroupView => group !== null),
    }
  })

  return { available: true, reports }
}
