/**
 * SG-1：ScopeGuard 越界拦截的持久化（session-map 蓝图 v3.36 / schema v51）。
 *
 * 边界：
 *  - 只写 `node_scope_violations`，**不碰 `node_evidence`**。理由见 `map/schema.ts`
 *    该表定义处的注释：`evidence_type` 值域不含 scope_violation；更关键的是
 *    `execution-state.ts` 的 `has('E2') → state='implemented'` 会把越界读成已交付。
 *  - 不参与任何派生 / gate / 验收判定；唯一消费方是证据面板（FR-S1-03）。
 *  - 写失败只告警、绝不阻断会话终止流程（越界处置优先级高于记账）。
 *
 * 归属口径：越界事件本身只带 `sandboxId`，节点上下文来自会话配置的 `nodeId`。
 * 解析不出节点（会话未绑定节点 / 节点已删 / 旧节点缺 `entity_key`）时**不写伪行**，
 * 只告警——宁可面板显示「未采集」，也不制造一条指不到节点的记录。
 */
import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('ScopeViolation')

export type ScopeViolationDisposition = 'pending' | 'rolled_back' | 'released'

export interface ScopeViolationRow {
  id: string
  project_path: string | null
  graph_id: string
  graph_type: 'online' | 'dev' | 'test'
  node_entity_key: string
  node_id: string | null
  session_id: string | null
  sandbox_id: string
  violations_json: string
  working_dir: string | null
  disposition: ScopeViolationDisposition
  created_at: string
  disposed_at: string | null
}

export interface RecordScopeViolationInput {
  /** 会话配置里的节点 id（AgentSessionConfig.nodeId）；为空则无法归属，跳过写入。 */
  nodeId?: string | null
  sessionId?: string | null
  sandboxId: string
  /** ScopeGuard 给出的越界项，原样落库。 */
  violations: string[]
  workingDirectory?: string | null
  projectPath?: string | null
  now?: Date
}

interface NodeContextRow {
  id: string
  entity_key: string | null
  graph_id: string
  graph_type: 'online' | 'dev' | 'test'
  project_path: string | null
}

/**
 * 记录一次越界拦截。返回写入的行；无法归属或写失败时返回 null（不抛）。
 */
export function recordScopeViolation(
  db: BetterSqlite3.Database,
  input: RecordScopeViolationInput,
): ScopeViolationRow | null {
  const violations = input.violations.filter((v) => typeof v === 'string' && v.length > 0)
  if (violations.length === 0) {
    logger.warn(`越界事件无有效条目（sandbox=${input.sandboxId}），跳过记录`)
    return null
  }

  const nodeId = input.nodeId ?? null
  if (!nodeId) {
    logger.warn(
      `越界事件缺少节点归属（sandbox=${input.sandboxId}, session=${input.sessionId ?? '-'}）：` +
        `会话未绑定节点，不写证据记录`,
    )
    return null
  }

  let node: NodeContextRow | undefined
  try {
    node = db
      .prepare(
        `SELECT n.id, n.entity_key, n.graph_id, n.graph_type, g.project_path
           FROM nodes n
           LEFT JOIN graphs g ON g.id = n.graph_id
          WHERE n.id = ?`,
      )
      .get(nodeId) as NodeContextRow | undefined
  } catch (err) {
    logger.warn(`越界记录查节点失败（node=${nodeId}）：${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  if (!node) {
    logger.warn(`越界记录找不到节点（node=${nodeId}），跳过写入`)
    return null
  }
  if (!node.entity_key) {
    logger.warn(`节点 ${nodeId} 缺 entity_key（旧数据未回填），越界记录无法按节点索引，跳过写入`)
    return null
  }

  const now = input.now ?? new Date()
  const row: ScopeViolationRow = {
    id: `nsv_${now.getTime()}_${randomUUID().slice(0, 8)}`,
    project_path: input.projectPath ?? node.project_path ?? null,
    graph_id: node.graph_id,
    graph_type: node.graph_type,
    node_entity_key: node.entity_key,
    node_id: node.id,
    session_id: input.sessionId ?? null,
    sandbox_id: input.sandboxId,
    violations_json: JSON.stringify(violations),
    working_dir: input.workingDirectory ?? null,
    disposition: 'pending',
    created_at: now.toISOString(),
    disposed_at: null,
  }

  try {
    db.prepare(
      `INSERT INTO node_scope_violations (
         id, project_path, graph_id, graph_type, node_entity_key, node_id,
         session_id, sandbox_id, violations_json, working_dir,
         disposition, created_at, disposed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.project_path, row.graph_id, row.graph_type, row.node_entity_key, row.node_id,
      row.session_id, row.sandbox_id, row.violations_json, row.working_dir,
      row.disposition, row.created_at, row.disposed_at,
    )
  } catch (err) {
    // 记账失败不得影响会话终止（越界处置优先级更高）。
    logger.warn(`越界记录写入失败（sandbox=${input.sandboxId}）：${err instanceof Error ? err.message : String(err)}`)
    return null
  }

  logger.info(
    `已记录越界拦截：node=${node.entity_key} sandbox=${input.sandboxId} 条目=${violations.length}`,
  )
  return row
}

/**
 * sandbox 回滚成功后回填处置状态。只更新仍为 `pending` 的行（幂等、可重入）。
 * 返回实际更新行数；回滚失败时**不调用**，让记录停在 pending（= 面板显示「未处置」）。
 */
export function markScopeViolationsRolledBack(
  db: BetterSqlite3.Database,
  sandboxId: string,
  now: Date = new Date(),
): number {
  try {
    const info = db
      .prepare(
        `UPDATE node_scope_violations
            SET disposition = 'rolled_back', disposed_at = ?
          WHERE sandbox_id = ? AND disposition = 'pending'`,
      )
      .run(now.toISOString(), sandboxId)
    return info.changes
  } catch (err) {
    logger.warn(`越界处置回填失败（sandbox=${sandboxId}）：${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}

/** 证据面板：按节点取越界记录（时间倒序）。 */
export function listScopeViolations(
  db: BetterSqlite3.Database,
  graphId: string,
  nodeEntityKey: string,
  limit = 50,
): ScopeViolationRow[] {
  return db
    .prepare(
      `SELECT * FROM node_scope_violations
        WHERE graph_id = ? AND node_entity_key = ?
        ORDER BY created_at DESC, id ASC
        LIMIT ?`,
    )
    .all(graphId, nodeEntityKey, limit) as ScopeViolationRow[]
}
