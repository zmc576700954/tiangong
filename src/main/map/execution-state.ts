/**
 * 派生引擎（S6a,session-map 蓝图 §3.3/§3.7.4/§3.7.5）
 *
 * 判定顺序（自顶向下命中即止,tie-break 确定性）：
 *  1. test_fail=true → failed（L1 无 test_* 表,恒 false;S8 后接入）
 *  2. 存在 running work_run → in_progress
 *  3. 当前 revision work_item gate_status='incomplete' 或依赖未满足 → blocked
 *  4. E3 fresh 未撤销 → verified
 *  5. E4 fresh 未撤销 → signed_off
 *  6. E3 stale,或过期未撤销 E4 → stale（U1 裁决;已撤销/覆盖变化 E4 不参与,
 *     落回后续规则）
 *  7. E2 未撤销 → implemented
 *  8. E1 或当前 revision work_item status ∈ draft/queued → planned
 *  9. 否则 untouched
 *
 * inputs_hash = sha256(canonical_json({derivation_version, evidence…, work_item…,
 * running_run_ids, test_fail}))——哈希未变跳过写入。工作区无证据且无任务时不写
 * untouched 假行（宁缺勿伪造）。nodes.status 永不参与、也不被回写。
 *
 * 重算触发（§3.7.5）：证据插入/撤销、work_item/work_run 状态变更 → 500ms 内按
 * 节点合并;失败保留上一行与原 computed_at,另写报告;无上一行宁可不写。
 */

import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('ExecutionState')

export const DERIVATION_VERSION = 1

/** 派生态变更通知载荷（§9.3 event:node-execution-state）。 */
export interface ExecutionStateChangePayload {
  graphId: string
  nodeEntityKey: string
  executionState: ExecutionState
  evidenceLevel: string
  staleCount: number
}

type ExecutionStateNotifier = (payload: ExecutionStateChangePayload) => void

let executionStateNotifier: ExecutionStateNotifier | undefined

/**
 * 注入派生态变更广播器（§9.3）。由 ipc-handlers 在装配期注入
 * broadcastToWindows——map 模块不反向依赖 IPC 层（layering）。
 */
export function setExecutionStateNotifier(cb: ExecutionStateNotifier | undefined): void {
  executionStateNotifier = cb
}

export type ExecutionState =
  | 'untouched' | 'planned' | 'in_progress' | 'implemented'
  | 'verified' | 'signed_off' | 'failed' | 'blocked' | 'stale'

export interface NodeExecutionStateRow {
  graph_id: string
  node_entity_key: string
  execution_state: ExecutionState
  evidence_level: 'E0' | 'E1' | 'E2' | 'E3' | 'E4'
  is_reproducible: number
  evidence_count: number
  stale_count: number
  derivation_version: number
  inputs_hash: string | null
  computed_at: number
}

export interface DerivationResult {
  state: ExecutionState
  evidenceLevel: 'E0' | 'E1' | 'E2' | 'E3' | 'E4'
  isReproducible: number
  evidenceCount: number
  staleCount: number
  inputsHash: string
  changed: boolean
}

const LEVEL_RANK: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 3 }

function canonicalJson(value: unknown): string {
  // 稳定序列化：对象键排序（数组保序）
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * 纯派生（可测）：给定输入集合按 §3.7.4 判定。
 */
export function deriveFromInputs(inputs: {
  evidence: Array<{ id: string; level: 'E1'|'E2'|'E3'|'E4'; freshness: string; revoked: boolean; expired: boolean; signedAt?: string | null; verifiedAt?: string | null }>
  workItem?: { id: string; status: string; gateStatus: string; dependsOn: string[] } | null
  dependencyStates: Array<{ id: string; status: string }>
  runningRunIds: string[]
  testFail: boolean
}): DerivationResult {
  const active = inputs.evidence.filter((e) => !e.revoked)
  // 有效 fresh:E3 看 freshness;E4 还须未过期(过期 E4 不得计入 signed_off,U1)
  const hasFresh = (level: 'E1'|'E2'|'E3'|'E4') =>
    active.some((e) => e.level === level && e.freshness === 'fresh' && !(e.level === 'E4' && e.expired))
  const has = (level: 'E1'|'E2'|'E3'|'E4', freshness?: 'fresh' | 'stale') =>
    active.some((e) => e.level === level && (freshness ? e.freshness === freshness : true))

  const staleE4 = active.some((e) => e.level === 'E4' && e.expired)
  const effectiveStaleCount = inputs.evidence.filter((e) => !e.revoked && (e.freshness === 'stale' || (e.level === 'E4' && e.expired))).length
  const evidenceCount = active.length

  const depsSatisfied = inputs.dependencyStates.every((d) => d.status === 'done')
  const item = inputs.workItem ?? null
  const itemPlanned = item != null && (item.status === 'draft' || item.status === 'queued')
  // §3.3 规则 3 的"未完成 work_item"细化为确认后的在途状态——draft/awaiting_confirm
  // 走规则 8 的 planned（否则 planned 分支不可达,与 §3.7.4 判定顺序冲突）。
  const ITEM_IN_FLIGHT = new Set(['queued', 'running', 'blocked', 'needs_input', 'needs_human', 'paused', 'interrupted'])
  const itemInFlight = item != null && ITEM_IN_FLIGHT.has(item.status)

  let state: ExecutionState
  if (inputs.testFail) state = 'failed'
  else if (inputs.runningRunIds.length > 0) state = 'in_progress'
  else if (itemInFlight && (item!.gateStatus === 'incomplete' || !depsSatisfied)) state = 'blocked'
  else if (hasFresh('E3')) state = 'verified'
  else if (hasFresh('E4') && !staleE4) state = 'signed_off'
  else if (has('E3', 'stale') || staleE4) state = 'stale'
  else if (has('E2')) state = 'implemented'
  else if (has('E1') || itemPlanned) state = 'planned'
  else state = 'untouched'

  // 参与判定的最高有效等级（未撤销）;E3/E4 同级取可复现组优先展示不合并——
  // level 记最高等级,verified/signed_off 已按状态区分,不合并统计。
  let maxLevel: 'E0' | 'E1' | 'E2' | 'E3' | 'E4' = 'E0'
  for (const e of active) {
    if (LEVEL_RANK[e.level] > LEVEL_RANK[maxLevel]) maxLevel = e.level
  }
  const isReproducible = maxLevel === 'E3' ? 1 : maxLevel === 'E4' ? 0 : 0

  const inputsHash = createHash('sha256')
    .update(canonicalJson({
      derivation_version: DERIVATION_VERSION,
      evidence: active.map((e) => ({ id: e.id, level: e.level, freshness: e.freshness, expired: e.expired })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      work_item_id: item?.id ?? null,
      work_item_status: item?.status ?? null,
      gate_status: item?.gateStatus ?? null,
      deps: inputs.dependencyStates.map((d) => ({ id: d.id, status: d.status })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      running_run_ids: [...inputs.runningRunIds].sort(),
      test_fail: inputs.testFail,
    }))
    .digest('hex')

  return {
    state,
    evidenceLevel: maxLevel,
    isReproducible,
    evidenceCount,
    staleCount: effectiveStaleCount,
    inputsHash,
    changed: true,
  }
}

/** 从库中收集派生输入并执行判定 + 落库（hash 未变跳过）。 */
export function recomputeExecutionState(
  db: BetterSqlite3.Database,
  graphId: string,
  nodeEntityKey: string,
  options?: { testFail?: boolean; now?: () => number },
): DerivationResult {
  const now = options?.now ?? Date.now
  const evidenceRows = db
    .prepare('SELECT * FROM node_evidence WHERE graph_id = ? AND node_entity_key = ? ORDER BY verified_at DESC, id ASC')
    .all(graphId, nodeEntityKey) as Array<{
      id: string; evidence_level: 'E1'|'E2'|'E3'|'E4'; freshness: string; revoked_at: string | null
      expires_at: string | null; verified_at: string | null; signed_at: string | null
    }>
  const evidence = evidenceRows.map((r) => ({
    id: r.id,
    level: r.evidence_level,
    freshness: r.freshness,
    revoked: r.revoked_at != null,
    expired: r.evidence_level === 'E4' && r.expires_at != null && new Date(r.expires_at).getTime() < now(),
    signedAt: r.signed_at,
    verifiedAt: r.verified_at,
  }))

  // 当前 revision 的 work_item（按 anchor_entity_key 锚定）
  const item = db
    .prepare('SELECT id, status, gate_status, depends_on_json FROM work_items WHERE graph_id = ? AND anchor_entity_key = ? AND is_current = 1 ORDER BY created_at DESC LIMIT 1')
    .get(graphId, nodeEntityKey) as { id: string; status: string; gate_status: string; depends_on_json: string } | undefined
  let dependencyStates: Array<{ id: string; status: string }> = []
  if (item) {
    let depIds: string[] = []
    try { depIds = JSON.parse(item.depends_on_json) as string[] } catch { depIds = [] }
    dependencyStates = depIds.map((depId) => {
      const dep = db
        .prepare('SELECT status FROM work_items WHERE id = ? AND is_current = 1')
        .get(depId) as { status: string } | undefined
      return { id: depId, status: dep?.status ?? 'missing' }
    })
  }

  const runningRunIds = item
    ? (db.prepare("SELECT id FROM work_runs WHERE work_item_id = ? AND status IN ('queued','running')").all(item.id) as Array<{ id: string }>).map((r) => r.id)
    : []

  const result = deriveFromInputs({
    evidence,
    workItem: item ? { id: item.id, status: item.status, gateStatus: item.gate_status, dependsOn: [] } : null,
    dependencyStates,
    runningRunIds,
    testFail: options?.testFail ?? false,
  })

  const existing = db
    .prepare('SELECT * FROM node_execution_state WHERE graph_id = ? AND node_entity_key = ?')
    .get(graphId, nodeEntityKey) as NodeExecutionStateRow | undefined

  // 工作区无证据无任务 → 不写 untouched 假行（§3.7.5:宁缺勿伪造）
  if (result.state === 'untouched' && !existing) {
    return { ...result, changed: false }
  }
  if (existing && existing.inputs_hash === result.inputsHash) {
    return { ...result, changed: false }
  }

  try {
    db.prepare(
      `INSERT INTO node_execution_state (
         graph_id, node_entity_key, execution_state, evidence_level, is_reproducible,
         evidence_count, stale_count, derivation_version, inputs_hash, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(graph_id, node_entity_key) DO UPDATE SET
         execution_state = excluded.execution_state,
         evidence_level = excluded.evidence_level,
         is_reproducible = excluded.is_reproducible,
         evidence_count = excluded.evidence_count,
         stale_count = excluded.stale_count,
         derivation_version = excluded.derivation_version,
         inputs_hash = excluded.inputs_hash,
         computed_at = excluded.computed_at`,
    ).run(
      graphId, nodeEntityKey, result.state, result.evidenceLevel, result.isReproducible,
      result.evidenceCount, result.staleCount, DERIVATION_VERSION, result.inputsHash, now(),
    )
  } catch (err) {
    // 重算失败:保留上一行与原 computed_at,写报告（§3.7.5）
    logger.warn(`execution_state write failed for ${graphId}/${nodeEntityKey.slice(0, 8)}…:`, err)
    db.prepare(
      `INSERT INTO map_migration_reports
         (id, kind, stage, schema_version, started_at, finished_at, owner_pid, status, error_json)
       VALUES (?, 'derivation', 'recompute', NULL, ?, ?, ?, 'failed', ?)`,
    ).run(
      `der_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      new Date().toISOString(), new Date().toISOString(), process.pid,
      JSON.stringify({ graph_id: graphId, node_entity_key: nodeEntityKey, error: err instanceof Error ? err.message : String(err) }),
    )
    return { ...result, changed: false }
  }
  // 状态变更 → 广播（§9.3 event:node-execution-state;渲染层叠加层据此增量更新）
  executionStateNotifier?.({
    graphId,
    nodeEntityKey,
    executionState: result.state,
    evidenceLevel: result.evidenceLevel,
    staleCount: result.staleCount,
  })
  return { ...result, changed: true }
}

// ---------------------------------------------------------
// 重算调度（§3.7.5:500ms 内按节点合并）
// ---------------------------------------------------------

interface PendingRecompute {
  timer: ReturnType<typeof setTimeout>
}

const pendingRecomputes = new Map<string, PendingRecompute>()

/**
 * 调度一次派生重算（事务提交后调用）。同节点 500ms 内合并;
 * timer unref,不阻止进程退出。测试可直接调 recomputeExecutionState 绕过调度。
 */
export function scheduleExecutionRecompute(db: BetterSqlite3.Database, graphId: string, nodeEntityKey: string): void {
  const key = `${graphId}::${nodeEntityKey}`
  if (pendingRecomputes.has(key)) return // 已排队,合并
  const timer = setTimeout(() => {
    pendingRecomputes.delete(key)
    try {
      recomputeExecutionState(db, graphId, nodeEntityKey)
    } catch (err) {
      logger.warn('scheduled recompute failed:', err)
    }
  }, 500)
  timer.unref?.()
  pendingRecomputes.set(key, { timer })
}

/** 供测试/退出前清空挂起的重算。 */
export function cancelPendingRecomputes(): void {
  for (const [, p] of pendingRecomputes) clearTimeout(p.timer)
  pendingRecomputes.clear()
}
