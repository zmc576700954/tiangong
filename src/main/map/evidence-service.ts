/**
 * EvidenceService（S6a,session-map 蓝图 §3.2/§3.5/§3.7.1 施工细则）
 *
 * 唯一合法写入方矩阵（违反即拒绝）：
 *  - E1 人（节点编辑/备注）——Agent 只能写 evidence_suggestions（L1 未建,即 Agent
 *    在 L1 不产任何证据）
 *  - E2 产物/变更清单（L1：human/test_executor/system;agent 直写拒绝——候选经接受
 *    的转换属 S6b evidence_suggestions 流程）
 *  - E3 TestExecutor 独占：commit 绑定 + code_dirty=0 + work_run_id + ref 内
 *    testRunId（test_run_id 不在 §7.2 列内,按 §3.7.2 放 ref_json 校验）;工作区
 *    dirty 不得产出 E3
 *  - E4 本地用户独占（Agent/后台任务代签禁止）：signed_by/signed_at/coverage_json
 *    （非空且至少一条含 acceptance_ids）/version_binding='none'/无 code hash
 *  - 唯一性：同 work_run_id+evidence_type+node_entity_key 的 E2/E3 只一条,
 *    重复写入返回既有 id（部分唯一索引兜底）
 *  - 写入前校验 graph_id+node_entity_key 可解析;E4 默认 30 天过期（可配置）
 *  - 撤销必填 revoke_reason;撤销/过期不删行
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type BetterSqlite3 from 'better-sqlite3'
import { scheduleExecutionRecompute } from './execution-state'

/** E4 过期天数（§3.5：统一 30 天,可配置）。 */
export const E4_EXPIRY_DAYS = 30

export type EvidenceLevel = 'E1' | 'E2' | 'E3' | 'E4'
export type Actor = 'human' | 'agent' | 'test_executor' | 'system'

export interface NodeEvidenceRow {
  id: string
  project_path: string | null
  graph_id: string
  graph_type: 'online' | 'dev' | 'test'
  node_entity_key: string
  node_id: string | null
  evidence_level: EvidenceLevel
  evidence_type:
    | 'changed_files' | 'commit' | 'test_run' | 'session_turn'
    | 'artifact' | 'human_confirm' | 'runtime_observation'
  ref_json: string
  summary: string | null
  version_binding: 'commit' | 'content_hash' | 'snapshot' | 'none'
  code_version: string | null
  code_dirty: number | null
  base_hash: string | null
  current_hash: string | null
  freshness: 'fresh' | 'stale' | 'unknown'
  produced_by: Actor
  work_item_id: string | null
  work_run_id: string | null
  session_id: string | null
  turn_id: string | null
  created_at: string
  verified_at: string | null
  stale_at: string | null
  signed_by: string | null
  signed_by_display_name: string | null
  signed_at: string | null
  coverage_json: string | null
  basis_ref_json: string | null
  reproducible: number | null
  expires_at: string | null
  renewed_from_evidence_id: string | null
  revoked_at: string | null
  revoked_by: string | null
  revoke_reason: string | null
}

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceValidationError'
  }
}

export interface CreateEvidenceInput {
  level: EvidenceLevel
  graphId: string
  nodeEntityKey: string
  nodeId?: string
  projectPath?: string
  evidenceType: NodeEvidenceRow['evidence_type']
  ref: unknown
  summary?: string
  producedBy?: Actor
  /** 调用方身份（写入方校验依据,缺省同 producedBy）。 */
  actor?: Actor
  // E3
  codeVersion?: string
  codeDirty?: number
  workRunId?: string
  workItemId?: string
  sessionId?: string
  turnId?: string
  // E4
  signedBy?: string
  signedByDisplayName?: string
  coverage?: Array<{ node_entity_key?: string; files?: string[]; acceptance_ids?: string[] }>
  basisRefs?: Array<{ kind: string; ref: string; hash?: string }>
  expiresAt?: string
  renewedFromEvidenceId?: string
}

export class EvidenceService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  get(id: string): NodeEvidenceRow | undefined {
    return this.db.prepare('SELECT * FROM node_evidence WHERE id = ?').get(id) as NodeEvidenceRow | undefined
  }

  listForNode(graphId: string, nodeEntityKey: string): NodeEvidenceRow[] {
    return this.db
      .prepare('SELECT * FROM node_evidence WHERE graph_id = ? AND node_entity_key = ? ORDER BY created_at DESC, id ASC')
      .all(graphId, nodeEntityKey) as NodeEvidenceRow[]
  }

  /** 写入（§3.7.1）。重复的 run 内 E2/E3 返回既有行。提交后调度派生重算。 */
  create(input: CreateEvidenceInput): { row: NodeEvidenceRow; reused: boolean } {
    const actor = input.actor ?? input.producedBy ?? 'system'
    const producedBy = input.producedBy ?? actor
    const refJson = JSON.stringify(input.ref ?? null)

    // ---- 写入方矩阵（§3.7.1）----
    if (input.level === 'E1' && actor !== 'human') {
      throw new EvidenceValidationError('E1 只能由人写入;Agent 走 evidence_suggestions（S6b）')
    }
    if (input.level === 'E2' && actor === 'agent') {
      throw new EvidenceValidationError('E2 的 agent 产物须先经 evidence_suggestions 接受（S6b）,L1 内 agent 不得直写')
    }
    if (input.level === 'E4' && actor !== 'human') {
      throw new EvidenceValidationError('E4 人工签收只能由本地用户写入;Agent/后台任务代签禁止（§3.5）')
    }
    if (input.level === 'E3' && actor !== 'test_executor') {
      throw new EvidenceValidationError('E3 只能由 TestExecutor 写入（§3.7.1）')
    }

    // ---- 端点可解析 ----
    const node = this.db
      .prepare('SELECT id, graph_type FROM nodes WHERE graph_id = ? AND entity_key = ?')
      .get(input.graphId, input.nodeEntityKey) as { id: string; graph_type: 'online' | 'dev' | 'test' } | undefined
    if (!node) {
      throw new EvidenceValidationError(`端点不可解析:graph=${input.graphId} key=${input.nodeEntityKey.slice(0, 8)}…`)
    }

    // ---- 等级字段组合校验（CHECK 之外的应用层前置,给出可读错误）----
    let versionBinding: NodeEvidenceRow['version_binding'] = 'commit'
    let codeVersion: string | null = null
    let codeDirty: number | null = null
    let reproducible: number | null = null
    let signedBy: string | null = null
    let signedByDisplay: string | null = null
    let signedAt: string | null = null
    let coverageJson: string | null = null
    let basisJson: string | null = null
    let expiresAt: string | null = null
    const now = new Date()

    if (input.level === 'E3') {
      if (input.codeVersion == null || input.codeVersion === '') {
        throw new EvidenceValidationError('E3 缺 code_version（commit 绑定,§3.7.2）')
      }
      if ((input.codeDirty ?? 0) !== 0) {
        throw new EvidenceValidationError('工作区 dirty 时不得产出 E3（§6.2.1/§3.7.2）')
      }
      if (!input.workRunId) {
        throw new EvidenceValidationError('E3 必须带 work_run_id（§3.7.1）')
      }
      // test_run_id 按依据放 ref_json.testRunId（§3.7.1 必填;列不在 §7.2 DDL）
      const refTestRunId = (input.ref as { testRunId?: string } | null)?.testRunId
      if (!refTestRunId) {
        throw new EvidenceValidationError('E3 的 ref_json 必须含 testRunId（§3.7.1/§6.2.1）')
      }
      versionBinding = 'commit'
      codeVersion = input.codeVersion
      codeDirty = 0
      reproducible = 1
    } else if (input.level === 'E4') {
      if (!input.signedBy || !input.signedBy) {
        throw new EvidenceValidationError('E4 缺 signed_by（§3.5）')
      }
      const coverage = input.coverage ?? []
      if (coverage.length === 0 || !coverage.some((c) => (c.acceptance_ids ?? []).length > 0)) {
        throw new EvidenceValidationError('E4 的 coverage_json 非空且至少覆盖一条 acceptance 条目（§3.5）')
      }
      versionBinding = 'none'
      codeVersion = null
      reproducible = 0
      signedBy = input.signedBy
      signedByDisplay = input.signedByDisplayName ?? null
      signedAt = now.toISOString()
      coverageJson = JSON.stringify(coverage)
      basisJson = input.basisRefs ? JSON.stringify(input.basisRefs) : null
      expiresAt = input.expiresAt ?? new Date(now.getTime() + E4_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString()
    } else {
      // E1/E2：ref 必填由 NOT NULL 兜底;version_binding 按内容形态默认
      versionBinding = input.level === 'E2' ? 'content_hash' : 'commit'
    }

    const txn = this.db.transaction((): { row: NodeEvidenceRow; reused: boolean } => {
      if (input.workRunId && (input.level === 'E2' || input.level === 'E3')) {
        const existing = this.db
          .prepare(
            `SELECT * FROM node_evidence
              WHERE work_run_id = ? AND evidence_type = ? AND node_entity_key = ?`,
          )
          .get(input.workRunId, input.evidenceType, input.nodeEntityKey) as NodeEvidenceRow | undefined
        if (existing) return { row: existing, reused: true }
      }
      const id = `ne_${Date.now()}_${randomUUID().slice(0, 8)}`
      this.db
        .prepare(
          `INSERT INTO node_evidence (
             id, project_path, graph_id, graph_type, node_entity_key, node_id,
             evidence_level, evidence_type, ref_json, summary,
             version_binding, code_version, code_dirty, freshness, produced_by,
             work_item_id, work_run_id, session_id, turn_id,
             created_at, verified_at, signed_by, signed_by_display_name, signed_at,
             coverage_json, basis_ref_json, reproducible, expires_at, renewed_from_evidence_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, input.projectPath ?? null, input.graphId, node.graph_type, input.nodeEntityKey,
          input.nodeId ?? node.id, input.level, input.evidenceType, refJson, input.summary ?? null,
          versionBinding, codeVersion, codeDirty, producedBy,
          input.workItemId ?? null, input.workRunId ?? null, input.sessionId ?? null, input.turnId ?? null,
          now.toISOString(), input.level === 'E3' ? now.toISOString() : null,
          signedBy, signedByDisplay, signedAt, coverageJson, basisJson, reproducible, expiresAt,
          input.renewedFromEvidenceId ?? null,
        )
      return { row: this.get(id)!, reused: false }
    })
    const result = txn()
    // 证据插入 → 事务提交后调度派生重算（§3.7.5）
    scheduleExecutionRecompute(this.db, input.graphId, input.nodeEntityKey)
    return result
  }

  /** 撤销（必填 reason;不删行）。撤销后调度重算（verified 消失）。 */
  revoke(id: string, revokedBy: string, revokeReason: string): NodeEvidenceRow {
    if (!revokeReason || revokeReason.trim() === '') {
      throw new EvidenceValidationError('人工撤销必填 revoke_reason（§3.5）')
    }
    const result = this.db
      .prepare('UPDATE node_evidence SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), revokedBy, revokeReason, id)
    if (result.changes !== 1) {
      throw new EvidenceValidationError(`证据 ${id} 不存在或已撤销`)
    }
    const row = this.get(id)!
    scheduleExecutionRecompute(this.db, row.graph_id, row.node_entity_key)
    return row
  }

  /** 一键续签（§3.5 方向）：以原 coverage 为默认生成新 E4,引用原证据。 */
  renewE4(oldId: string, signedBy: string, signedByDisplayName?: string): NodeEvidenceRow {
    const old = this.get(oldId)
    if (!old || old.evidence_level !== 'E4') {
      throw new EvidenceValidationError('续签目标必须是 E4 证据')
    }
    const { row } = this.create({
      level: 'E4',
      graphId: old.graph_id,
      nodeEntityKey: old.node_entity_key,
      nodeId: old.node_id ?? undefined,
      projectPath: old.project_path ?? undefined,
      evidenceType: 'human_confirm',
      ref: { renewedFrom: oldId },
      summary: old.summary ?? undefined,
      actor: 'human',
      producedBy: 'human',
      signedBy,
      signedByDisplayName,
      coverage: JSON.parse(old.coverage_json!) as Array<{ node_entity_key?: string; files?: string[]; acceptance_ids?: string[] }>,
      basisRefs: old.basis_ref_json ? JSON.parse(old.basis_ref_json) : undefined,
      renewedFromEvidenceId: oldId,
    })
    return row
  }

  /** E3 stale 扫描（§3.7.5:启动+每小时）：HEAD 与 code_version 不一致 → stale。 */
  markStaleE3(graphId: string, nodeEntityKey: string, currentHead: string): number {
    const rows = this.db
      .prepare(
        `SELECT id, code_version FROM node_evidence
          WHERE graph_id = ? AND node_entity_key = ? AND evidence_level = 'E3'
            AND revoked_at IS NULL AND freshness = 'fresh'`,
      )
      .all(graphId, nodeEntityKey) as Array<{ id: string; code_version: string }>
    let n = 0
    for (const r of rows) {
      if (r.code_version !== currentHead) {
        this.db
          .prepare("UPDATE node_evidence SET freshness = 'stale', stale_at = ? WHERE id = ?")
          .run(new Date().toISOString(), r.id)
        n += 1
      }
    }
    if (n > 0) scheduleExecutionRecompute(this.db, graphId, nodeEntityKey)
    return n
  }
}

/**
 * §3.7.5 E3 stale 扫描（启动后 + 每小时,全图批量）：按图取项目 HEAD,凡
 * code_version !== HEAD 的 fresh E3 → stale。git 不可用/失败跳过该图（只告警,
 * 不误标）。L1 无 TestExecutor → 无 E3 行,早退休眠（S8 接入后生效）。
 */
export function scanStaleE3All(db: BetterSqlite3.Database): { graphs: number; staled: number } {
  const graphs = db
    .prepare(
      `SELECT DISTINCT e.graph_id AS graph_id, g.project_path AS project_path
         FROM node_evidence e
         JOIN graphs g ON g.id = e.graph_id
        WHERE e.evidence_level = 'E3' AND e.revoked_at IS NULL AND e.freshness = 'fresh'
          AND g.project_path IS NOT NULL AND g.project_path != ''`,
    )
    .all() as Array<{ graph_id: string; project_path: string }>
  if (graphs.length === 0) return { graphs: 0, staled: 0 }

  const svc = new EvidenceService(db)
  let staled = 0
  for (const g of graphs) {
    let head: string
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: g.project_path, encoding: 'utf-8' }).trim()
    } catch (err) {
      console.warn(`E3 stale scan: git HEAD failed for ${g.project_path}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const nodes = db
      .prepare(
        `SELECT DISTINCT node_entity_key FROM node_evidence
          WHERE graph_id = ? AND evidence_level = 'E3' AND revoked_at IS NULL AND freshness = 'fresh'`,
      )
      .all(g.graph_id) as Array<{ node_entity_key: string }>
    for (const r of nodes) {
      staled += svc.markStaleE3(g.graph_id, r.node_entity_key, head)
    }
  }
  return { graphs: graphs.length, staled }
}
