/**
 * G2-13 published 软阻断（session-map 蓝图 §6.5.2 / §6.5.2.1）。
 *
 * 与 G2 gate waiver 是**两套事实**：
 *  - gate waiver：`work_items.gate_status='waived'` + `gate_waived_by/at/reason`，
 *    作用于「任务执行前的 gate」，由 Agent/人工审批（agent_approvals）驱动；
 *  - published waiver：`nodes.published_waiver_json`，作用于「测试资产发布」，
 *    只影响徽标/统计，不阻断任务执行，也不写 gate_status。
 *
 * 通过记录口径（裁决）：test-case 节点 → `test_specs.test_node_entity_key` →
 * 执行记录（`test_results` / `test_runs`）→ 是否存在未撤销 E3。
 * **不能**直接查 test-case 节点自身的 E3。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode } from '../../shared/types/graph'
import { ErrorCode } from '../errors'
import { IpcError } from '../errors'

export interface PassEvidenceReport {
  hasPassEvidence: boolean
  specIds: string[]
  passedRunCount: number
  e3TargetCount: number
  lastTestStatus: string | null
}

export interface PublishedWaiver {
  by: string
  at: number
  reason: string
  missing: string[]
}

export interface PublishedWaiverParseResult {
  ok: boolean
  waiver?: PublishedWaiver
  missing: string[]
}

const EMPTY_EVIDENCE: PassEvidenceReport = {
  hasPassEvidence: false,
  specIds: [],
  passedRunCount: 0,
  e3TargetCount: 0,
  lastTestStatus: null,
}

/**
 * 计算某个 test-case 节点的通过记录。图隔离：spec 允许 `graph_id IS NULL`
 * （历史测试规格未绑图），其余一律要求同图。
 */
export function computePassEvidence(
  db: BetterSqlite3.Database,
  graphId: string,
  testNodeEntityKey: string | null | undefined,
): PassEvidenceReport {
  if (!testNodeEntityKey) return EMPTY_EVIDENCE

  const specs = db
    .prepare(
      `SELECT id FROM test_specs
        WHERE test_node_entity_key = ?
          AND (graph_id IS NULL OR graph_id = ?)`,
    )
    .all(testNodeEntityKey, graphId) as Array<{ id: string }>
  if (specs.length === 0) return EMPTY_EVIDENCE

  const specIds = specs.map((s) => s.id)
  const placeholders = specIds.map(() => '?').join(',')
  const results = db
    .prepare(
      `SELECT r.spec_id, r.test_run_id, r.target_node_entity_key, r.status, r.created_at,
              tr.status AS run_status
         FROM test_results r
         LEFT JOIN test_runs tr ON tr.id = r.test_run_id
        WHERE r.spec_id IN (${placeholders})
        ORDER BY r.created_at DESC`,
    )
    .all(...specIds) as Array<{
      spec_id: string
      test_run_id: string | null
      target_node_entity_key: string | null
      status: string | null
      created_at: number
      run_status: string | null
    }>

  const passedRuns = new Set<string>()
  for (const row of results) {
    if (row.run_status === 'passed' && row.test_run_id) passedRuns.add(row.test_run_id)
  }

  const e3Rows = db
    .prepare(
      `SELECT DISTINCT node_entity_key FROM node_evidence
        WHERE graph_id = ?
          AND evidence_level = 'E3'
          AND revoked_at IS NULL
          AND freshness = 'fresh'`,
    )
    .all(graphId) as Array<{ node_entity_key: string }>
  const e3Targets = new Set(e3Rows.map((r) => r.node_entity_key))
  const hitTargets = new Set<string>()
  for (const row of results) {
    if (row.target_node_entity_key && e3Targets.has(row.target_node_entity_key)) {
      hitTargets.add(row.target_node_entity_key)
    }
  }

  return {
    hasPassEvidence: passedRuns.size > 0 || hitTargets.size > 0,
    specIds,
    passedRunCount: passedRuns.size,
    e3TargetCount: hitTargets.size,
    lastTestStatus: results[0]?.status ?? null,
  }
}

/**
 * 解析 `published_waiver_json`。缺任一字段都返回 ok=false 并列出缺失项；
 * 兼容「已解析对象」与「JSON 字符串」两种入参。
 */
export function parsePublishedWaiver(raw: unknown): PublishedWaiverParseResult {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { ok: false, missing: ['json'] }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, missing: ['json'] }
  }
  const obj = value as Record<string, unknown>
  const missing: string[] = []
  if (typeof obj.by !== 'string' || obj.by.trim() === '') missing.push('by')
  if (typeof obj.at !== 'number' || !Number.isFinite(obj.at)) missing.push('at')
  if (typeof obj.reason !== 'string' || obj.reason.trim() === '') missing.push('reason')
  if (!Array.isArray(obj.missing) || !obj.missing.every((m) => typeof m === 'string')) {
    missing.push('missing')
  }
  if (missing.length > 0) return { ok: false, missing }

  return {
    ok: true,
    missing: [],
    waiver: {
      by: obj.by as string,
      at: obj.at as number,
      reason: obj.reason as string,
      missing: obj.missing as string[],
    },
  }
}

/**
 * `node:update` 发布拦截：只有 test 图的 test-case 节点、且无通过记录时才要求豁免。
 * 有通过记录直接放行；无通过记录且豁免不完整 → `PUBLISHED_WAIVER_REQUIRED`。
 */
export function assertPublishedUpdateAllowed(
  db: BetterSqlite3.Database,
  node: Pick<GraphNode, 'type' | 'graphId' | 'graphType' | 'entityKey'>,
  data: { status?: string; publishedWaiverJson?: unknown },
): void {
  if (data.status !== 'published') return
  if (node.graphType !== 'test' || node.type !== 'test-case') return
  if (computePassEvidence(db, node.graphId, node.entityKey).hasPassEvidence) return

  const parsed = parsePublishedWaiver(data.publishedWaiverJson)
  if (!parsed.ok) {
    throw new IpcError(
      `发布无通过记录的 test-case 需提供完整 published_waiver_json（缺: ${parsed.missing.join(', ')}）`,
      ErrorCode.PUBLISHED_WAIVER_REQUIRED,
    )
  }
}

export interface PublishedNodeStatus {
  id: string
  entityKey: string | null
  title: string
  status: string
  hasPassEvidence: boolean
  /** 未发布为 null；已发布按是否有通过记录取 verified / unverified。 */
  badge: 'verified' | 'unverified' | null
  lastTestStatus: string | null
  /** 最近一条执行结果是否失败（§6.5.2.1「徽标追加最近测试失败」的数据口径）。 */
  lastTestFailed: boolean
}

export interface PublishedGraphStatus {
  graphId: string
  total: number
  published: number
  verified: number
  publishedWithoutEvidence: number
  nodes: PublishedNodeStatus[]
}

/**
 * 只读统计/徽标（UI 不做）：按 test 图的 test-case 节点汇总。
 * 与发布写路径共用 `computePassEvidence`，避免两套判定。
 */
export function getPublishedStatus(
  db: BetterSqlite3.Database,
  graphId: string,
): PublishedGraphStatus {
  const rows = db
    .prepare(
      `SELECT id, entity_key, title, status FROM nodes
        WHERE graph_id = ? AND type = 'test-case'
        ORDER BY title ASC, id ASC`,
    )
    .all(graphId) as Array<{ id: string; entity_key: string | null; title: string; status: string }>

  const nodes: PublishedNodeStatus[] = rows.map((row) => {
    const evidence = computePassEvidence(db, graphId, row.entity_key)
    const published = row.status === 'published'
    return {
      id: row.id,
      entityKey: row.entity_key,
      title: row.title,
      status: row.status,
      hasPassEvidence: evidence.hasPassEvidence,
      badge: published ? (evidence.hasPassEvidence ? 'verified' : 'unverified') : null,
      lastTestStatus: evidence.lastTestStatus,
      lastTestFailed:
        evidence.lastTestStatus === 'failed' ||
        evidence.lastTestStatus === 'error' ||
        evidence.lastTestStatus === 'timed_out',
    }
  })

  const publishedNodes = nodes.filter((n) => n.status === 'published')
  const verified = publishedNodes.filter((n) => n.hasPassEvidence).length
  return {
    graphId,
    total: nodes.length,
    published: publishedNodes.length,
    verified,
    publishedWithoutEvidence: publishedNodes.length - verified,
    nodes,
  }
}
