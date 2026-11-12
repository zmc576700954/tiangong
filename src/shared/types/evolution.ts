/**
 * 进化层只读视图的 IPC DTO（G2-3 / G2-4 / G2-16 的读出口）。
 *
 * 三块数据本来只在库里（`memory_hits` v44、`v_memory_attribution` v46、
 * `map_migration_reports(kind='calibration')` v49），渲染层看不到。这里只定义
 * 「查出来长什么样」，不含任何写语义；主进程 `map/evolution-read.ts` 负责
 * 把落库口径（snake_case、原始 JSON 串）翻成这里的驼峰 DTO。
 */

export type MemoryHitKindView = 'context' | 'step' | 'evidence' | 'deviation'

export type SourceOutcomeView = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'interrupted'

/** 一条命中：只存引用不存全文（II-05），所以这里也只有 `sourceRef`。 */
export interface MemoryHitView {
  id: string
  projectPath: string
  graphId: string
  nodeId: string | null
  workItemId: string | null
  runId: string
  stepId: string | null
  hitKind: MemoryHitKindView
  /** v45 前的存量行为 null：那时还没记终态来源。 */
  sourceOutcome: SourceOutcomeView | null
  sourceRef: string
  score: number
  createdAt: string
}

export interface MemoryHitCountView {
  key: string
  count: number
}

export interface MemoryHitListResult {
  /**
   * false = 该库还没有 `memory_hits`（v44 迁移未跑）。界面必须区分
   * 「表不存在」与「表在但没数据」，不能都显示成空列表。
   */
  available: boolean
  rows: MemoryHitView[]
  /** 命中总数（受同一过滤条件约束，不受 limit 影响）。 */
  total: number
  byKind: MemoryHitCountView[]
  byOutcome: MemoryHitCountView[]
}

export interface AttributionRowView {
  runId: string
  stepId: string | null
  graphId: string
  adapter: string | null
  modeId: string | null
  outcome: SourceOutcomeView | null
  /** 该 run 的命中条数（无命中为 0）。 */
  hitCount: number
  evidenceLevel: number | null
  /** 同一 (graph, adapter, mode) 分区的样本数。 */
  sampleSize: number
  conclusion: 'ok' | 'insufficient_sample'
}

export interface AttributionSummaryView {
  totalRuns: number
  runsWithHit: number
  /** 命中率 = 有命中的 run / 全部归因 run；无样本时为 null。 */
  hitRate: number | null
  byOutcome: MemoryHitCountView[]
  /** 视图里的样本阈值（当前 20），界面据此解释 `insufficient_sample`。 */
  minSample: number
  groupsOk: number
  groupsInsufficient: number
}

export interface AttributionListResult {
  /** false = 该库还没有 `v_memory_attribution` 视图（v46 未跑）。 */
  available: boolean
  rows: AttributionRowView[]
  total: number
  summary: AttributionSummaryView
}

/** 校准报告里的一个分组（`plan-calibration.ts` 的 CalibrationGroup 的读侧投影）。 */
export interface CalibrationGroupView {
  derivationVersion: string
  observedRuleVersion: string
  taskType: string
  agentType: string | null
  runCount: number
  fileRatio: number | null
  subtaskRatio: number | null
  replanMedian: number
  reworkCount: number
  testFailures: number
  scopeViolationRate: number
  boundaryChangedRate: number
  signals: string[]
}

export interface CalibrationReportView {
  id: string
  startedAt: string
  finishedAt: string | null
  status: string
  windowStart: string | null
  windowEnd: string | null
  runCount: number
  minRuns: number
  groups: CalibrationGroupView[]
  /**
   * `stats_json` 解析失败时的原因。报告行本身仍返回（不隐藏），
   * 但 `groups` 为空——界面要能看出「这行在库里但读不出来」而不是「没分组」。
   */
  parseError: string | null
}

export interface CalibrationReportListResult {
  /** false = 该库还没有 `map_migration_reports` 表。 */
  available: boolean
  reports: CalibrationReportView[]
}

/** 进化层三条只读通道的过滤参数（全部可选，缺省取最近 N 条）。 */
export interface EvolutionQuery {
  projectPath?: string
  graphId?: string
  runId?: string
  hitKind?: MemoryHitKindView
  adapter?: string
  limit?: number
}
