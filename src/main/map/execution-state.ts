/**
 * 派生引擎（S6a,session-map 蓝图 §3.3/§3.7.4/§3.7.5）
 *
 * 判定顺序（自顶向下命中即止,tie-break 确定性）：
 *  1. test_fail=true → failed（生产来源：活跃 item 最近一次 run 终态为 failed 且
 *     failure_class='test_fail';重试开始或新 run 成功即解除）
 *  2. 存在 running work_run → in_progress
 *  3. 任一活跃 item gate_status='incomplete' 或依赖未满足 → blocked
 *  4. E3 fresh 未撤销 → verified
 *  5. E4 fresh 未撤销 → signed_off
 *  6. E3 stale,或过期未撤销 E4 → stale（U1 裁决;已撤销/覆盖变化 E4 不参与,
 *     落回后续规则）
 *  7. E2 未撤销 → implemented
 *  8. E1 或任一活跃 item status ∈ draft/queued → planned
 *  9. 否则 untouched
 *
 * 同一 anchor 允许多条 lineage 并存（§4.1）：derivation v2 对**活跃集**（非终态
 * 当前 revision）聚合，而不是只取 created_at 最新的一条（v1 会吞掉其他 lineage 的
 * running/blocked/test_fail）。活跃集为空时回退到最新一条。
 *
 * inputs_hash = sha256(canonical_json({derivation_version, evidence…, work_items…,
 * running_run_ids, test_fail}))——work_items 为排序后的 (id,status,gate) 列表；
 * 哈希未变跳过写入。工作区无证据且无任务时不写 untouched 假行（宁缺勿伪造）。
 * nodes.status 永不参与、也不被回写。
 *
 * 重算触发（§3.7.5）：证据插入/撤销、work_item/work_run 状态变更 →
 * `scheduleRecomputeForWorkItem` 只重算「该 item 锚定的节点 + 把它列为直接依赖的
 * 节点」（不扫全图、不全量重算）,500ms 内按节点合并;读缓存前
 * `flushPendingRecomputes` 立即兑现挂起重算。失败保留上一行与原 computed_at,
 * 另写报告;无上一行宁可不写。
 */

import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('ExecutionState')

export const DERIVATION_VERSION = 2

/** 终态 item：不参与活跃集聚合（无活跃集时才回退到最新一条）。 */
export const WORK_ITEM_TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'superseded'])

/** 在途 item 状态（§3.3 规则 3 的细化）。 */
const ITEM_IN_FLIGHT = new Set(['queued', 'running', 'blocked', 'needs_input', 'needs_human', 'paused', 'interrupted'])

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
  /** 同一 anchor 的全部当前 revision item，按 created_at DESC, id ASC 传入。 */
  workItems: Array<{ id: string; status: string; gateStatus: string; depsSatisfied: boolean }>
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

  // 同一 anchor 允许多条 lineage 并存（§4.1）。取「活跃集」聚合；全部终态时回退到
  // 最新一条，保持单 lineage 的既有语义。只取最新一条会吞掉其他 lineage 的
  // running/blocked/test_fail（DERIVATION_VERSION 1 的缺陷）。
  const activeItems = inputs.workItems.filter((w) => !WORK_ITEM_TERMINAL_STATUSES.has(w.status))
  const representative = activeItems.length > 0 ? activeItems : inputs.workItems.slice(0, 1)
  const itemPlanned = representative.some((w) => w.status === 'draft' || w.status === 'queued')
  // §3.3 规则 3 的"未完成 work_item"细化为在途且（gate 未过或依赖未满足）。
  // draft/awaiting_confirm 走规则 8 的 planned。
  const itemBlocked = representative.some(
    (w) => ITEM_IN_FLIGHT.has(w.status) && (w.gateStatus === 'incomplete' || !w.depsSatisfied),
  )

  let state: ExecutionState
  if (inputs.testFail) state = 'failed'
  else if (inputs.runningRunIds.length > 0) state = 'in_progress'
  else if (itemBlocked) state = 'blocked'
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
      // 排序后的 (item_id, status, gate) 列表：多 lineage 并存时保证确定性。
      work_items: inputs.workItems
        .map((w) => ({ id: w.id, status: w.status, gate_status: w.gateStatus, deps_satisfied: w.depsSatisfied ? 1 : 0 }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
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

/**
 * test_fail 的生产来源：该 item 最近一次 run 终态为 failed 且 failure_class='test_fail'。
 * 只看最近一次 run（run_seq 单调）——重试已入队/正在跑时最近一条不是失败；新 run
 * 成功也不再算失败。这样不需要调用方把瞬态 flag 传进 500ms 去抖队列（会被合并丢失）。
 */
function latestRunIsTestFail(db: BetterSqlite3.Database, workItemId: string): boolean {
  const row = db
    .prepare('SELECT status, failure_class FROM work_runs WHERE work_item_id = ? ORDER BY run_seq DESC LIMIT 1')
    .get(workItemId) as { status: string; failure_class: string | null } | undefined
  return row?.status === 'failed' && row.failure_class === 'test_fail'
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

  // 同一 anchor 的全部当前 revision item（多 lineage 聚合，DERIVATION_VERSION 2）。
  // 排序固定为 created_at DESC, id ASC：活跃集为空时回退到最新一条。
  const itemRows = db
    .prepare(
      `SELECT id, status, gate_status, depends_on_json FROM work_items
        WHERE graph_id = ? AND anchor_entity_key = ? AND is_current = 1
        ORDER BY created_at DESC, id ASC`,
    )
    .all(graphId, nodeEntityKey) as Array<{ id: string; status: string; gate_status: string; depends_on_json: string }>

  const activeRows = itemRows.filter((r) => !WORK_ITEM_TERMINAL_STATUSES.has(r.status))
  const effectiveRows = activeRows.length > 0 ? activeRows : itemRows.slice(0, 1)

  const workItems = itemRows.map((row) => {
    let depIds: string[] = []
    try { depIds = JSON.parse(row.depends_on_json) as string[] } catch { depIds = [] }
    const depsSatisfied = depIds.every((depId) => {
      const dep = db
        .prepare('SELECT status FROM work_items WHERE id = ? AND is_current = 1')
        .get(depId) as { status: string } | undefined
      return dep?.status === 'done'
    })
    return { id: row.id, status: row.status, gateStatus: row.gate_status, depsSatisfied }
  })

  const effectiveIds = effectiveRows.map((r) => r.id)
  const runningRunIds = effectiveIds.length
    ? (db
        .prepare(
          `SELECT id FROM work_runs WHERE work_item_id IN (${effectiveIds.map(() => '?').join(',')})
             AND status IN ('queued','running')`,
        )
        .all(...effectiveIds) as Array<{ id: string }>).map((r) => r.id)
    : []

  const result = deriveFromInputs({
    evidence,
    workItems,
    runningRunIds,
    // options.testFail 仅供纯关联/测试覆盖;生产从 work_runs 推导。
    testFail: options?.testFail ?? effectiveIds.some((id) => latestRunIsTestFail(db, id)),
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
  db: BetterSqlite3.Database
  graphId: string
  nodeEntityKey: string
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
  pendingRecomputes.set(key, { timer, db, graphId, nodeEntityKey })
}

/**
 * work_item 状态/gate/revision 变更后触发重算。范围只含两类节点：
 *  1. 该 item 锚定的节点（`anchor_entity_key`）；
 *  2. 当前 revision 中把该 item 列为直接依赖的节点（这些节点的 `blocked` 判定
 *     依赖本 item 状态）。
 * 不做全图扫描，也不在每次变更时全量重算;每个节点仍走 500ms 合并 + inputs_hash
 * 未变跳过。依赖只影响直接上游/下游，无需递归传播。
 */
export function scheduleRecomputeForWorkItem(db: BetterSqlite3.Database, workItemId: string): void {
  const item = db
    .prepare('SELECT graph_id, anchor_entity_key FROM work_items WHERE id = ?')
    .get(workItemId) as { graph_id: string; anchor_entity_key: string | null } | undefined
  if (!item) return
  const targets = new Set<string>()
  if (item.anchor_entity_key) targets.add(item.anchor_entity_key)
  const dependents = db
    .prepare(
      `SELECT anchor_entity_key, depends_on_json FROM work_items
        WHERE graph_id = ? AND is_current = 1 AND anchor_entity_key IS NOT NULL
          AND depends_on_json LIKE ?`,
    )
    .all(item.graph_id, `%"${workItemId}"%`) as Array<{ anchor_entity_key: string; depends_on_json: string }>
  for (const d of dependents) {
    try {
      const ids = JSON.parse(d.depends_on_json) as unknown
      if (Array.isArray(ids) && ids.includes(workItemId)) targets.add(d.anchor_entity_key)
    } catch {
      // 脏 depends_on_json 只影响它自己的节点，不阻断其他目标重算。
    }
  }
  for (const key of targets) scheduleExecutionRecompute(db, item.graph_id, key)
}

/**
 * 立即兑现挂起的重算（可按 db/graph 限定）。`map:overlay:get` 读
 * `node_execution_state` 缓存前必须先调它，否则 500ms 去抖窗口内会读到旧状态
 * （状态刚变、缓存还没重算）。
 */
export function flushPendingRecomputes(db: BetterSqlite3.Database, graphId?: string): void {
  const due: Array<[string, PendingRecompute]> = []
  for (const entry of pendingRecomputes) {
    const [key, p] = entry
    if (p.db !== db) continue
    if (graphId && p.graphId !== graphId) continue
    due.push([key, p])
  }
  for (const [key, p] of due) {
    clearTimeout(p.timer)
    pendingRecomputes.delete(key)
    try {
      recomputeExecutionState(p.db, p.graphId, p.nodeEntityKey)
    } catch (err) {
      logger.warn('flushed recompute failed:', err)
    }
  }
}

/**
 * 派生逻辑升级后的缓存刷新：把本图中 `derivation_version < CURRENT` 的行逐节点重算。
 *
 * 选择读侧惰性刷新而非启动全盘扫描：`node_execution_state` 的唯一消费路径是
 * `map:overlay:get`，按被查看图刷新成本有界，且不让未被查看的节点拖慢启动。
 * 重算后版本即更新，重复读取不再触发。
 */
export function refreshStaleDerivationsForGraph(db: BetterSqlite3.Database, graphId: string): number {
  const stale = db
    .prepare('SELECT node_entity_key FROM node_execution_state WHERE graph_id = ? AND derivation_version < ?')
    .all(graphId, DERIVATION_VERSION) as Array<{ node_entity_key: string }>
  let refreshed = 0
  for (const row of stale) {
    try {
      recomputeExecutionState(db, graphId, row.node_entity_key)
      refreshed++
    } catch (err) {
      logger.warn(`stale derivation refresh failed for ${graphId}/${row.node_entity_key.slice(0, 8)}…:`, err)
    }
  }
  return refreshed
}

/** 供测试/退出前清空挂起的重算。 */
export function cancelPendingRecomputes(): void {
  for (const [, p] of pendingRecomputes) clearTimeout(p.timer)
  pendingRecomputes.clear()
}
