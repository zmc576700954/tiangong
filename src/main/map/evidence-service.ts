/**
 * EvidenceService（S6a,session-map 蓝图 §3.2/§3.5/§3.7.1 施工细则）
 *
 * 唯一合法写入方矩阵（违反即拒绝）：
 *  - E1 人（节点/证据面板手写判断）——Agent 不得起草 E1（判断走文本,不进证据）;
 *    人工直写经 `createHumanJudgment`,固定 `actor/produced_by='human'`
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
  /** v42/G11-10：E3 执行树的 git tree 哈希（可空，不参与 gate）。 */
  tree_hash: string | null
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
  /** E2 content_hash 绑定(测试事实:current_hash=执行后 worktree 内容指纹,§6.2.1) */
  currentHash?: string
  /** E3 可选树绑定（G11-10）：执行树的 git tree 哈希;只记录,不参与等级/gate 判定。 */
  treeHash?: string
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

/**
 * E1 人工判断直写入参（G3-10）。
 *
 * 只收「谁在看哪个对象、写了什么判断」：等级固定 E1、写入方固定 human，
 * 不接受调用方自报 actor/producedBy。`ref_json` 指向被判断对象（节点/证据/任务等）；
 * 可选 `idempotencyKey` 落到 `ref_json.idempotencyKey`，同一判断重复提交返回既有行。
 */
export interface CreateHumanJudgmentInput {
  graphId: string
  nodeEntityKey: string
  nodeId?: string
  projectPath?: string
  summary: string
  ref: unknown
  idempotencyKey?: string
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

  /** 只读：按 work_item 取证据（UI 从任务下钻时用；含已撤销/过期行,由前端按 revoked_at/freshness 展示）。 */
  listForWorkItem(workItemId: string, limit = 200): NodeEvidenceRow[] {
    return this.db
      .prepare('SELECT * FROM node_evidence WHERE work_item_id = ? ORDER BY created_at DESC, id ASC LIMIT ?')
      .all(workItemId, limit) as NodeEvidenceRow[]
  }

  /** 写入（§3.7.1）。重复的 run 内 E2/E3 返回既有行。提交后调度派生重算。 */
  create(input: CreateEvidenceInput): { row: NodeEvidenceRow; reused: boolean } {
    const actor = input.actor ?? input.producedBy ?? 'system'
    const producedBy = input.producedBy ?? actor

    // §3.7.1：ref_json 必填。列是 NOT NULL，但 `null` 序列化后同样是合法文本，
    // 因此应用层必须显式拒绝，避免写入一条「不可溯源」的空证据。
    if (input.ref === undefined || input.ref === null) {
      throw new EvidenceValidationError('证据缺 ref_json（§3.7.1）')
    }
    const refJson = JSON.stringify(input.ref)

    // ---- 写入方矩阵（§3.7.1）----
    if (input.level === 'E1' && actor !== 'human') {
      throw new EvidenceValidationError('E1 只能由人写入;agent 不得起草 E1（判断走文本,不进证据）')
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
    let treeHash: string | null = null
    const now = new Date()

    // G11-10：tree_hash 只表达「E3 那次执行对应的 git 树」，不扩展到其他等级。
    if (input.level !== 'E3' && input.treeHash != null) {
      throw new EvidenceValidationError('tree_hash 只用于 E3（G11-10）')
    }

    if (input.level === 'E3') {
      // §3.7.1 禁止项：E3 是测试事实，不接受人工签收字段（否则会被静默丢弃）。
      if (input.signedBy != null || input.coverage != null) {
        throw new EvidenceValidationError('E3 不得携带人工签收字段（signed_by/coverage）')
      }
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
      treeHash = input.treeHash ?? null
    } else if (input.level === 'E4') {
      // §3.5/§3.7.1 禁止项：E4 必须 version_binding='none'，不得携带 **代码** hash。
      // 注意 `current_hash` 在 E4 上是「产物文件内容绑定」（见 acceptance-confirmation），
      // 不是代码锚点，按代码事实放行；这里只拦 code_version/code_dirty。
      if (input.codeVersion != null || input.codeDirty != null) {
        throw new EvidenceValidationError('E4 不得携带代码 hash（code_version/code_dirty）')
      }
      if (!input.signedBy || input.signedBy.trim() === '') {
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
      // E1/E2：上面已统一校验 ref 非空；这里再拦「等级专属字段混入」，
      // 避免调用方以为传了 signed_by/coverage（E1/E2 没有这些语义）却被静默丢弃。
      if (input.codeVersion != null || input.codeDirty != null || input.signedBy != null || input.coverage != null) {
        throw new EvidenceValidationError(`${input.level} 不得携带 E3/E4 专属字段（code_version/code_dirty/signed_by/coverage）`)
      }
      if (input.level === 'E1' && (!input.summary || input.summary.trim() === '')) {
        throw new EvidenceValidationError('E1 缺 summary（§3.7.1：人工备注必填）')
      }
      versionBinding = input.level === 'E2' ? 'content_hash' : 'commit'
    }

    const txn = this.db.transaction((): { row: NodeEvidenceRow; reused: boolean } => {
      if (input.workRunId && (input.level === 'E2' || input.level === 'E3')) {
        const existing = this.db
          .prepare(
            `SELECT * FROM node_evidence
              WHERE graph_id = ? AND work_run_id = ? AND evidence_type = ? AND node_entity_key = ?`,
          )
          .get(input.graphId, input.workRunId, input.evidenceType, input.nodeEntityKey) as NodeEvidenceRow | undefined
        if (existing) return { row: existing, reused: true }
      }
      const id = `ne_${Date.now()}_${randomUUID().slice(0, 8)}`
      this.db
        .prepare(
          `INSERT INTO node_evidence (
             id, project_path, graph_id, graph_type, node_entity_key, node_id,
             evidence_level, evidence_type, ref_json, summary,
             version_binding, code_version, code_dirty, current_hash, tree_hash, freshness, produced_by,
             work_item_id, work_run_id, session_id, turn_id,
             created_at, verified_at, signed_by, signed_by_display_name, signed_at,
             coverage_json, basis_ref_json, reproducible, expires_at, renewed_from_evidence_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, input.projectPath ?? null, input.graphId, node.graph_type, input.nodeEntityKey,
          input.nodeId ?? node.id, input.level, input.evidenceType, refJson, input.summary ?? null,
          versionBinding, codeVersion, codeDirty, input.currentHash ?? null, treeHash, producedBy,
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

  /**
   * E1 人工判断直写（G3-10）。
   *
   * 与 `create()` 的区别：等级/写入方由服务端固定，调用方不能自报 actor；
   * 校验沿用 E1 既有口径（`ref_json` 非空、`summary` 必填），不新增列。
   * 幂等键放 `ref_json.idempotencyKey`，同图同节点同键重复提交返回既有行，
   * 不产生第二条 E1（E1 没有部分唯一索引，靠服务层 + json_extract 收口）。
   */
  createHumanJudgment(input: CreateHumanJudgmentInput): { row: NodeEvidenceRow; reused: boolean } {
    if (!input.summary || input.summary.trim() === '') {
      throw new EvidenceValidationError('E1 缺 summary（§3.7.1：人工备注必填）')
    }
    if (input.ref === undefined || input.ref === null) {
      throw new EvidenceValidationError('证据缺 ref_json（§3.7.1）')
    }
    const key = input.idempotencyKey?.trim()
    let ref = input.ref
    if (key) {
      const refObject =
        typeof input.ref === 'object' && !Array.isArray(input.ref)
          ? (input.ref as Record<string, unknown>)
          : { ref: input.ref }
      ref = { ...refObject, idempotencyKey: key }
      const existing = this.db
        .prepare(
          `SELECT * FROM node_evidence
            WHERE graph_id = ? AND node_entity_key = ? AND evidence_level = 'E1'
              AND json_extract(ref_json, '$.idempotencyKey') = ?
            ORDER BY created_at DESC, id ASC LIMIT 1`,
        )
        .get(input.graphId, input.nodeEntityKey, key) as NodeEvidenceRow | undefined
      if (existing) return { row: existing, reused: true }
    }

    return this.create({
      level: 'E1',
      graphId: input.graphId,
      nodeEntityKey: input.nodeEntityKey,
      nodeId: input.nodeId,
      projectPath: input.projectPath,
      evidenceType: 'human_confirm',
      ref,
      summary: input.summary.trim(),
      actor: 'human',
      producedBy: 'human',
    })
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
 * `evidence_suggestions` 服务（§3.4/§3.7.1）：系统/Agent 推断只能写建议，
 * 接受时在同一事务内转 `node_evidence`；拒绝只改状态、不写证据。
 *
 * 去重口径（§I.3 W2 步骤②「node+kind+source_ref」）：同一节点 + 同一证据类型 +
 * 同一来源（优先 `produced_by_run_id`；无 run 时用 `ref_json`）只保留一条 `pending`。
 * 接受/驳回都是条件更新（`WHERE status='pending'`），重复调用按既有状态返回，
 * 不产生第二条证据。
 */
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed'

export interface EvidenceSuggestionRow {
  id: string
  project_path: string | null
  graph_id: string
  node_entity_key: string
  node_id: string | null
  suggested_level: EvidenceLevel
  evidence_type: NodeEvidenceRow['evidence_type']
  ref_json: string
  rationale: string
  confidence: number
  status: SuggestionStatus
  produced_by_run_id: string | null
  created_at: string
  resolved_at: string | null
  resolved_by: string | null
}

export interface SuggestEvidenceInput {
  graphId: string
  nodeEntityKey: string
  nodeId?: string
  projectPath?: string
  level: EvidenceLevel
  evidenceType: NodeEvidenceRow['evidence_type']
  ref: unknown
  /** 给人看的推断理由（必填，接受后作为证据 summary）。 */
  rationale: string
  confidence?: number
  producedByRunId?: string
}

/**
 * 建议可提议的等级：**不含 E1**。
 *
 * E1 是人的判断信号，只能由人工经 `EvidenceService.createHumanJudgment` 直写；
 * agent 想表达判断走文本，不进入证据/建议流。库层 CHECK 仍保留 E1 只为兼容
 * 历史行（不为删值做 v38 迁移），写入侧由服务层收口。
 */
const SUGGESTION_LEVELS: EvidenceLevel[] = ['E2', 'E3', 'E4']
const EVIDENCE_TYPES: NodeEvidenceRow['evidence_type'][] = [
  'changed_files', 'commit', 'test_run', 'session_turn',
  'artifact', 'human_confirm', 'runtime_observation',
]

export class EvidenceSuggestionService {
  private readonly evidence: EvidenceService

  constructor(private readonly db: BetterSqlite3.Database) {
    this.evidence = new EvidenceService(db)
  }

  get(id: string): EvidenceSuggestionRow | undefined {
    return this.db.prepare('SELECT * FROM evidence_suggestions WHERE id = ?').get(id) as
      | EvidenceSuggestionRow
      | undefined
  }

  listForNode(
    graphId: string,
    nodeEntityKey: string,
    status?: SuggestionStatus,
    limit = 200,
  ): EvidenceSuggestionRow[] {
    if (status) {
      return this.db
        .prepare(
          `SELECT * FROM evidence_suggestions
            WHERE graph_id = ? AND node_entity_key = ? AND status = ?
            ORDER BY created_at DESC, id ASC LIMIT ?`,
        )
        .all(graphId, nodeEntityKey, status, limit) as EvidenceSuggestionRow[]
    }
    return this.db
      .prepare(
        `SELECT * FROM evidence_suggestions
          WHERE graph_id = ? AND node_entity_key = ?
          ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .all(graphId, nodeEntityKey, limit) as EvidenceSuggestionRow[]
  }

  list(graphId: string, status: SuggestionStatus = 'pending', limit = 200): EvidenceSuggestionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM evidence_suggestions
          WHERE graph_id = ? AND status = ?
          ORDER BY created_at DESC, id ASC LIMIT ?`,
      )
      .all(graphId, status, limit) as EvidenceSuggestionRow[]
  }

  /** 写入建议（重复的来源只返回既有 pending 行）。 */
  suggest(input: SuggestEvidenceInput): { row: EvidenceSuggestionRow; reused: boolean } {
    if (!SUGGESTION_LEVELS.includes(input.level)) {
      throw new EvidenceValidationError(`建议等级非法:${String(input.level)}`)
    }
    if (!EVIDENCE_TYPES.includes(input.evidenceType)) {
      throw new EvidenceValidationError(`证据类型非法:${String(input.evidenceType)}`)
    }
    if (input.ref === undefined || input.ref === null) {
      throw new EvidenceValidationError('建议缺 ref_json（§3.4）')
    }
    if (!input.rationale || input.rationale.trim() === '') {
      throw new EvidenceValidationError('建议缺 rationale（§3.4：必须说明推断理由）')
    }
    const confidence = input.confidence ?? 0.5
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new EvidenceValidationError('建议 confidence 必须在 [0,1]')
    }
    const node = this.db
      .prepare('SELECT id FROM nodes WHERE graph_id = ? AND entity_key = ?')
      .get(input.graphId, input.nodeEntityKey) as { id: string } | undefined
    if (!node) {
      throw new EvidenceValidationError(
        `建议端点不可解析:graph=${input.graphId} key=${input.nodeEntityKey.slice(0, 8)}…`,
      )
    }

    const refJson = JSON.stringify(input.ref)
    const now = new Date().toISOString()
    const txn = this.db.transaction((): { row: EvidenceSuggestionRow; reused: boolean } => {
      const existing = (
        input.producedByRunId
          ? this.db
              .prepare(
                `SELECT * FROM evidence_suggestions
                  WHERE graph_id = ? AND node_entity_key = ? AND evidence_type = ?
                    AND status = 'pending' AND produced_by_run_id = ?`,
              )
              .get(input.graphId, input.nodeEntityKey, input.evidenceType, input.producedByRunId)
          : this.db
              .prepare(
                `SELECT * FROM evidence_suggestions
                  WHERE graph_id = ? AND node_entity_key = ? AND evidence_type = ?
                    AND status = 'pending' AND produced_by_run_id IS NULL AND ref_json = ?`,
              )
              .get(input.graphId, input.nodeEntityKey, input.evidenceType, refJson)
      ) as EvidenceSuggestionRow | undefined
      if (existing) return { row: existing, reused: true }

      const id = `es_${Date.now()}_${randomUUID().slice(0, 8)}`
      this.db
        .prepare(
          `INSERT INTO evidence_suggestions (
             id, project_path, graph_id, node_entity_key, node_id,
             suggested_level, evidence_type, ref_json, rationale, confidence,
             status, produced_by_run_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          id, input.projectPath ?? null, input.graphId, input.nodeEntityKey, input.nodeId ?? node.id,
          input.level, input.evidenceType, refJson, input.rationale.trim(), confidence,
          input.producedByRunId ?? null, now,
        )
      return { row: this.get(id)!, reused: false }
    })
    return txn()
  }

  /**
   * 接受建议：**同一事务**内 ① 条件更新建议状态 ② 写 node_evidence。
   * 已接受再次调用返回既有证据（按 ref_json.suggestionId 定位），不重复写。
   */
  accept(
    id: string,
    resolvedBy: string,
  ): { suggestion: EvidenceSuggestionRow; evidence: NodeEvidenceRow; reused: boolean } {
    if (!resolvedBy || resolvedBy.trim() === '') {
      throw new EvidenceValidationError('接受建议必须提供 resolvedBy（审计要求）')
    }
    const txn = this.db.transaction(
      (): { suggestion: EvidenceSuggestionRow; evidence: NodeEvidenceRow; reused: boolean } => {
        const suggestion = this.get(id)
        if (!suggestion) throw new EvidenceValidationError(`建议 ${id} 不存在`)
        const existingEvidence = this.findEvidenceBySuggestion(id)
        if (suggestion.status === 'accepted') {
          if (!existingEvidence) {
            throw new EvidenceValidationError(`建议 ${id} 已接受但找不到对应证据（状态不一致，需人工核查）`)
          }
          return { suggestion, evidence: existingEvidence, reused: true }
        }
        if (suggestion.status === 'dismissed') {
          throw new EvidenceValidationError(`建议 ${id} 已驳回，不能接受`)
        }
        // §3.7.1：E3 只能由 TestExecutor 写入，建议不得把人工点击洗成可复现证据。
        if (suggestion.suggested_level === 'E3') {
          throw new EvidenceValidationError('E3 只能由 TestExecutor 写入（§3.7.1），建议不允许代为升级')
        }
        // G3-10：E1 只能由人工直写（`createHumanJudgment`）。历史库可能残留 E1 建议，
        // 接受会把「agent 推断」洗成「人的判断」，故在此显式拒绝。
        if (suggestion.suggested_level === 'E1') {
          throw new EvidenceValidationError('E1 只能由人工判断直写（G3-10），建议不得代为升级')
        }

        const now = new Date().toISOString()
        const updated = this.db
          .prepare(
            `UPDATE evidence_suggestions
                SET status = 'accepted', resolved_at = ?, resolved_by = ?
              WHERE id = ? AND status = 'pending'`,
          )
          .run(now, resolvedBy.trim(), id)
        if (updated.changes !== 1) {
          throw new EvidenceValidationError(`建议 ${id} 状态已被并发修改，拒绝重复接受`)
        }

        const ref = safeJsonObject(suggestion.ref_json)
        const { row: evidence } = this.evidence.create(this.toEvidenceInput(suggestion, ref, resolvedBy))
        return { suggestion: this.get(id)!, evidence, reused: false }
      },
    )
    return txn()
  }

  /** 驳回建议：只改状态，不写证据；重复驳回返回既有状态。 */
  dismiss(id: string, resolvedBy: string): EvidenceSuggestionRow {
    if (!resolvedBy || resolvedBy.trim() === '') {
      throw new EvidenceValidationError('驳回建议必须提供 resolvedBy（审计要求）')
    }
    const txn = this.db.transaction((): EvidenceSuggestionRow => {
      const suggestion = this.get(id)
      if (!suggestion) throw new EvidenceValidationError(`建议 ${id} 不存在`)
      if (suggestion.status === 'dismissed') return suggestion
      if (suggestion.status === 'accepted') {
        throw new EvidenceValidationError(`建议 ${id} 已接受，不能驳回`)
      }
      const updated = this.db
        .prepare(
          `UPDATE evidence_suggestions
              SET status = 'dismissed', resolved_at = ?, resolved_by = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(new Date().toISOString(), resolvedBy.trim(), id)
      if (updated.changes !== 1) {
        throw new EvidenceValidationError(`建议 ${id} 状态已被并发修改，拒绝重复驳回`)
      }
      return this.get(id)!
    })
    return txn()
  }

  private findEvidenceBySuggestion(suggestionId: string): NodeEvidenceRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM node_evidence
          WHERE json_extract(ref_json, '$.suggestionId') = ?
          ORDER BY created_at DESC, id ASC LIMIT 1`,
      )
      .get(suggestionId) as NodeEvidenceRow | undefined
  }

  /** 建议 → 证据：来源字段从 ref_json 结构化回填，`suggestionId` 追加进 ref_json 供追溯。 */
  private toEvidenceInput(
    suggestion: EvidenceSuggestionRow,
    ref: Record<string, unknown>,
    resolvedBy: string,
  ): CreateEvidenceInput {
    const str = (value: unknown): string | undefined =>
      typeof value === 'string' && value !== '' ? value : undefined
    const level = suggestion.suggested_level
    // E1 已被 `SUGGESTION_LEVELS` 与 `accept()` 双重拦住，只剩 E4 由人工签收。
    const producedBy: Actor =
      level === 'E4'
        ? 'human'
        : suggestion.produced_by_run_id
          ? 'agent'
          : 'system'

    const input: CreateEvidenceInput = {
      level,
      graphId: suggestion.graph_id,
      nodeEntityKey: suggestion.node_entity_key,
      nodeId: suggestion.node_id ?? undefined,
      projectPath: suggestion.project_path ?? undefined,
      evidenceType: suggestion.evidence_type,
      ref: { ...ref, suggestionId: suggestion.id },
      summary: suggestion.rationale,
      actor: 'human',
      producedBy,
      workRunId: suggestion.produced_by_run_id ?? str(ref.runId),
      workItemId: str(ref.workItemId),
      sessionId: str(ref.sessionId),
      turnId: str(ref.turnId),
      currentHash: str(ref.executedContentHash),
    }

    if (level === 'E4') {
      // 人工点击接受 = 人工签收：签名人必须是接受者本人，覆盖范围取自建议。
      input.signedBy = resolvedBy.trim()
      input.coverage = Array.isArray(ref.coverage)
        ? (ref.coverage as Array<{ node_entity_key?: string; files?: string[]; acceptance_ids?: string[] }>)
        : undefined
    }
    return input
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
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

/**
 * §3.7.5 E4 到期扫描（启动后 + 每日一次,全库批量）。
 * 只处理 E4（version_binding='none'、code_version NULL）:expires_at <= now 的
 * fresh E4 → stale,与 E3 的 HEAD 比对无关,不共用判定。扫描结果落
 * map_migration_reports(kind='derivation', stage='e4_expiry'),可按 stage 查询。
 */
export function scanExpiredE4All(
  db: BetterSqlite3.Database,
  now: Date = new Date(),
): { scanned: number; staled: number; reportId: string } {
  const nowIso = now.toISOString()
  const reportId = `mig_e4expiry_${randomUUID().slice(0, 8)}`
  const expired = db
    .prepare(
      `SELECT id, graph_id, node_entity_key FROM node_evidence
        WHERE evidence_level = 'E4' AND revoked_at IS NULL AND freshness = 'fresh'
          AND version_binding = 'none' AND code_version IS NULL
          AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(nowIso) as Array<{ id: string; graph_id: string; node_entity_key: string }>

  const targets = new Map<string, { graphId: string; entityKey: string }>()
  let staled = 0
  db.transaction(() => {
    for (const row of expired) {
      const res = db
        .prepare("UPDATE node_evidence SET freshness = 'stale', stale_at = ? WHERE id = ? AND freshness = 'fresh'")
        .run(nowIso, row.id)
      if (res.changes > 0) {
        staled += 1
        targets.set(`${row.graph_id}::${row.node_entity_key}`, {
          graphId: row.graph_id,
          entityKey: row.node_entity_key,
        })
      }
    }
    db.prepare(
      `INSERT INTO map_migration_reports (id, kind, stage, started_at, finished_at, status, stats_json)
       VALUES (?, 'derivation', 'e4_expiry', ?, ?, 'ok', ?)`,
    ).run(reportId, nowIso, nowIso, JSON.stringify({ scanned: expired.length, staled, checkedAt: nowIso }))
  })()

  for (const t of targets.values()) scheduleExecutionRecompute(db, t.graphId, t.entityKey)
  return { scanned: expired.length, staled, reportId }
}
