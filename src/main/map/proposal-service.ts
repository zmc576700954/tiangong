/**
 * ProposalService（G1-14 提案机制,session-map 蓝图 §2.7 / II-02）
 *
 * 提案 = 对 online 产品事实的**待人工采纳**变更。复用 `work_items` 承载，
 * 载荷放 `metadata.proposal`，**不新增表**；只读视图 `v_online_proposals`
 * 供列表/徽标查询。本服务只改提案自身的 `work_items` 行，**任何路径都不写
 * online 图**（不 UPDATE nodes / edges）——采纳由人编辑 online 后自行确认。
 *
 * 状态机（提案子集）：
 *   draft → awaiting_confirm → done（采纳）/ cancelled（驳回，必带理由）
 *   conflict_group 有前序 open 时 → blocked；前序终态后提升回 awaiting_confirm。
 *
 * G2-6 细节并入本文件：`conflict_group` 串行、`weight`（0–1，仅影响展示排序）、
 * 同实体并发上限 3、阻塞等待超 24h 自动取消（expireStale）。
 *
 * 注意：提案不创建 `work_steps`，也不进入执行调度——它是留痕/审批对象，
 * 不是可被 agent 执行的 work item。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'

const logger = createLogger('ProposalService')

/** before/after 单字段上限（字节）；超出截断并标 truncated（§2.7）。 */
export const PROPOSAL_FIELD_MAX_BYTES = 200 * 1024
/** 同实体并发提案上限（含 blocked；§2.7 / II-08）。 */
export const MAX_PROPOSALS_PER_ENTITY = 3
/** blocked 等待上限：超时自动取消（II-08）。 */
export const PROPOSAL_BLOCKED_TIMEOUT_MS = 24 * 60 * 60 * 1000

export type ProposalStatus = 'draft' | 'awaiting_confirm' | 'queued' | 'blocked' | 'done' | 'cancelled' | 'failed' | 'superseded'

const OPEN_STATUSES: readonly ProposalStatus[] = ['awaiting_confirm', 'queued']
const NON_TERMINAL_STATUSES: readonly ProposalStatus[] = ['draft', 'awaiting_confirm', 'queued', 'blocked']

export type ProposalErrorCode = 'INVALID' | 'CONFLICT' | 'NOT_FOUND' | 'STALE'

export class ProposalError extends Error {
  constructor(public readonly code: ProposalErrorCode, message: string) {
    super(message)
    this.name = 'ProposalError'
  }
}

export interface ProposalPayload {
  before: string
  after: string
  reason: string
  evidence_refs: string[]
  base_revision: string | null
  conflict_group: string | null
  weight: number
  truncated: boolean
  blocked_by: string | null
  created_via: 'proposal'
  accepted_at?: string
  accepted_by?: string
  rejected_at?: string
  rejected_by?: string
  reject_reason?: string
}

export interface ProposalViewRow {
  id: string
  lineage_id: string
  revision: number
  project_path: string | null
  graph_id: string
  anchor_entity_key: string
  title: string
  status: ProposalStatus
  cancel_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  base_revision: string | null
  conflict_group: string | null
  weight: number | null
  truncated: number | null
  reject_reason: string | null
  online_updated_at: string | null
  stale: number
}

export interface ProposalDiff {
  id: string
  graphId: string
  nodeEntityKey: string
  status: ProposalStatus
  title: string
  reason: string | null
  evidenceRefs: string[]
  baseRevision: string | null
  onlineUpdatedAt: string | null
  conflictGroup: string | null
  weight: number | null
  truncated: boolean
  stale: boolean
  rejectReason: string | null
  before: unknown
  after: unknown
  /** 原文（截断后）；解析失败时 UI 仍可展示而不是白屏。 */
  beforeText: string
  afterText: string
}

export interface CreateProposalInput {
  projectPath?: string
  graphId: string
  anchorEntityKey: string
  anchorNodeId?: string
  title: string
  reason: string
  before?: unknown
  after: unknown
  evidenceRefs?: string[]
  /** 默认取锚定节点当前 updated_at。 */
  baseRevision?: string
  conflictGroup?: string
  /** 0–1；缺省 0.5。仅影响列表展示排序。 */
  weight?: number
  createdBy?: string
}

interface ProposalMetaRow {
  metadata: string | null
}

function isProposalStatus(value: unknown): value is ProposalStatus {
  return (
    value === 'draft' || value === 'awaiting_confirm' || value === 'queued' || value === 'blocked' ||
    value === 'done' || value === 'cancelled' || value === 'failed' || value === 'superseded'
  )
}

/** JSON 序列化 + 200KB 截断（按字节，避免多字节字符被切坏）。 */
function serializeCapped(value: unknown): { text: string; truncated: boolean } {
  const text = JSON.stringify(value === undefined ? null : value)
  if (Buffer.byteLength(text, 'utf8') <= PROPOSAL_FIELD_MAX_BYTES) {
    return { text, truncated: false }
  }
  const buf = Buffer.from(text, 'utf8').subarray(0, PROPOSAL_FIELD_MAX_BYTES)
  // 去掉可能被切断的 UTF-8 尾字节，再标记截断。
  const safe = buf.toString('utf8').replace(/\uFFFD+$/, '')
  return { text: `${safe}…[truncated]`, truncated: true }
}

function parseProposal(metadata: string | null): ProposalPayload | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as { proposal?: ProposalPayload }
    return parsed?.proposal && typeof parsed.proposal === 'object' ? parsed.proposal : null
  } catch {
    return null
  }
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export class ProposalService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private now(): string {
    return new Date().toISOString()
  }

  /**
   * 创建提案：写入 draft 后在同一事务内推进到 awaiting_confirm。
   *
   * 说明：提案不经 `workitem:run:start` 的 gate 路径（它不是可执行任务），
   * 因此这里用条件更新完成 draft → awaiting_confirm 这条边，不绕过任何
   * 执行守卫——提案永远不会进入 queued/running。
   */
  create(input: CreateProposalInput): { row: Record<string, unknown>; proposal: ProposalPayload } {
    if (!input.graphId) throw new ProposalError('INVALID', 'graphId 必填')
    if (!input.anchorEntityKey) throw new ProposalError('INVALID', 'anchorEntityKey 必填')
    if (!input.title || input.title.trim() === '') throw new ProposalError('INVALID', 'title 必填')
    if (!input.reason || input.reason.trim() === '') throw new ProposalError('INVALID', 'reason 必填')
    if (input.after === undefined) throw new ProposalError('INVALID', 'after 必填')
    const weight = input.weight ?? 0.5
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new ProposalError('INVALID', 'weight 必须是 0–1 的数字')
    }
    const conflictGroup = input.conflictGroup?.trim() ? input.conflictGroup.trim() : null
    const evidenceRefs = (input.evidenceRefs ?? []).filter((ref) => typeof ref === 'string' && ref.trim() !== '')

    const node = this.db
      .prepare('SELECT id, title, description, status, content, metadata, updated_at FROM nodes WHERE graph_id = ? AND entity_key = ? LIMIT 1')
      .get(input.graphId, input.anchorEntityKey) as
      | { id: string; title: string; description: string | null; status: string; content: string | null; metadata: string | null; updated_at: string }
      | undefined
    if (!node) {
      throw new ProposalError('NOT_FOUND', `online 实体不存在：graph=${input.graphId} entity=${input.anchorEntityKey}`)
    }

    const baseRevision = input.baseRevision ?? node.updated_at
    const beforeSnapshot = input.before === undefined
      ? { title: node.title, description: node.description, status: node.status, content: node.content, metadata: node.metadata }
      : input.before
    const before = serializeCapped(beforeSnapshot)
    const after = serializeCapped(input.after)

    const id = `wi_${Date.now()}_${randomUUID().slice(0, 8)}`
    const lineageId = `wl_${Date.now()}_${randomUUID().slice(0, 8)}`
    const now = this.now()

    const txn = this.db.transaction((): { row: Record<string, unknown>; proposal: ProposalPayload } => {
      const siblings = this.db
        .prepare(
          `SELECT id, status FROM work_items
            WHERE graph_id = ? AND anchor_entity_key = ? AND is_current = 1
              AND json_extract(metadata, '$.proposal') IS NOT NULL`,
        )
        .all(input.graphId, input.anchorEntityKey) as Array<{ id: string; status: ProposalStatus }>
      const nonTerminal = siblings.filter((s) => NON_TERMINAL_STATUSES.includes(s.status))
      if (nonTerminal.some((s) => OPEN_STATUSES.includes(s.status))) {
        throw new ProposalError('CONFLICT', '同一实体只允许一个 open 提案（awaiting_confirm/queued）')
      }
      if (nonTerminal.length >= MAX_PROPOSALS_PER_ENTITY) {
        throw new ProposalError('CONFLICT', `同实体并发提案上限 ${MAX_PROPOSALS_PER_ENTITY}`)
      }

      let blockedBy: string | null = null
      if (conflictGroup) {
        const predecessor = this.db
          .prepare(
            `SELECT id FROM work_items
              WHERE graph_id = ? AND is_current = 1
                AND json_extract(metadata, '$.proposal.conflict_group') = ?
                AND status IN ('awaiting_confirm','queued')
              ORDER BY created_at ASC LIMIT 1`,
          )
          .get(input.graphId, conflictGroup) as { id: string } | undefined
        blockedBy = predecessor?.id ?? null
      }

      const proposal: ProposalPayload = {
        before: before.text,
        after: after.text,
        reason: input.reason.trim(),
        evidence_refs: evidenceRefs,
        base_revision: baseRevision,
        conflict_group: conflictGroup,
        weight,
        truncated: before.truncated || after.truncated,
        blocked_by: blockedBy,
        created_via: 'proposal',
      }

      this.db
        .prepare(
          `INSERT INTO work_items (
             id, lineage_id, revision, is_current, project_path, graph_id,
             anchor_entity_key, anchor_node_id, depth, title, goal,
             scope_files, acceptance_json, verification_hint, metadata,
             status, origin, created_by, created_at, updated_at
           ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, 0, ?, ?, '[]', '[]', NULL, ?, 'draft', 'human', ?, ?, ?)`,
        )
        .run(
          id, lineageId, input.projectPath ?? null, input.graphId,
          input.anchorEntityKey, input.anchorNodeId ?? node.id,
          input.title.trim(), proposal.reason,
          JSON.stringify({ proposal }), input.createdBy ?? null, now, now,
        )

      if (blockedBy) {
        this.db
          .prepare("UPDATE work_items SET status = 'blocked', updated_at = ? WHERE id = ? AND status = 'draft'")
          .run(now, id)
      } else {
        this.db
          .prepare("UPDATE work_items SET status = 'awaiting_confirm', updated_at = ? WHERE id = ? AND status = 'draft'")
          .run(now, id)
      }

      const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Record<string, unknown>
      logger.info(`proposal ${id}: created (${blockedBy ? 'blocked' : 'awaiting_confirm'}) for ${input.graphId}/${input.anchorEntityKey}`)
      return { row, proposal }
    })

    return txn()
  }

  /** 只读列表：默认排除 done/cancelled/superseded；weight 降序仅影响展示。 */
  list(query: {
    graphId?: string
    anchorEntityKey?: string
    includeResolved?: boolean
    limit?: number
  }): ProposalViewRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (query.graphId) {
      where.push('graph_id = ?')
      params.push(query.graphId)
    }
    if (query.anchorEntityKey) {
      where.push('anchor_entity_key = ?')
      params.push(query.anchorEntityKey)
    }
    if (!query.includeResolved) {
      where.push("status NOT IN ('done','cancelled','failed','superseded')")
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200)
    const sql = `
      SELECT id, lineage_id, revision, project_path, graph_id, anchor_entity_key, title,
             status, cancel_reason, created_by, created_at, updated_at, base_revision,
             conflict_group, weight, truncated, reject_reason, online_updated_at, stale
        FROM v_online_proposals
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE status WHEN 'awaiting_confirm' THEN 0 WHEN 'queued' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
                COALESCE(weight, 0) DESC,
                created_at DESC
       LIMIT ?`
    return this.db.prepare(sql).all(...params, limit) as ProposalViewRow[]
  }

  /** 只读 diff：返回解析后的 before/after；解析失败保留原文。 */
  diff(id: string): ProposalDiff | null {
    const row = this.db
      .prepare(
        `SELECT id, graph_id, anchor_entity_key, title, status, reason, evidence_refs_json,
                base_revision, online_updated_at, conflict_group, weight, truncated,
                reject_reason, before_json, after_json, stale
           FROM v_online_proposals WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string
          graph_id: string
          anchor_entity_key: string
          title: string
          status: ProposalStatus
          reason: string | null
          evidence_refs_json: string | null
          base_revision: string | null
          online_updated_at: string | null
          conflict_group: string | null
          weight: number | null
          truncated: number | null
          reject_reason: string | null
          before_json: string | null
          after_json: string | null
          stale: number
        }
      | undefined
    if (!row) return null
    let evidenceRefs: string[] = []
    try {
      const parsed = JSON.parse(row.evidence_refs_json ?? '[]') as unknown
      if (Array.isArray(parsed)) evidenceRefs = parsed.filter((v): v is string => typeof v === 'string')
    } catch {
      evidenceRefs = []
    }
    const beforeText = row.before_json ?? 'null'
    const afterText = row.after_json ?? 'null'
    return {
      id: row.id,
      graphId: row.graph_id,
      nodeEntityKey: row.anchor_entity_key,
      status: row.status,
      title: row.title,
      reason: row.reason,
      evidenceRefs,
      baseRevision: row.base_revision,
      onlineUpdatedAt: row.online_updated_at,
      conflictGroup: row.conflict_group,
      weight: row.weight,
      truncated: row.truncated === 1,
      stale: row.stale === 1,
      rejectReason: row.reject_reason,
      before: parseJsonText(beforeText),
      after: parseJsonText(afterText),
      beforeText,
      afterText,
    }
  }

  /**
   * 采纳：只把提案收口为 done，**不修改 online 节点**。
   * 幂等键按 `lineage_id + revision`：已 done 再调用返回 reused=true。
   */
  accept(id: string, opts: { acceptedBy: string }): { row: Record<string, unknown>; reused: boolean } {
    if (!opts.acceptedBy || opts.acceptedBy.trim() === '') {
      throw new ProposalError('INVALID', 'acceptedBy 必填（采纳审计主体）')
    }
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as ({ status: ProposalStatus } & ProposalMetaRow) | undefined
    if (!row) throw new ProposalError('NOT_FOUND', `提案不存在：${id}`)
    const proposal = parseProposal(row.metadata)
    if (!proposal) throw new ProposalError('INVALID', `work_item ${id} 不是提案（缺 metadata.proposal）`)
    if (row.status === 'done') return { row: row as unknown as Record<string, unknown>, reused: true }
    if (!OPEN_STATUSES.includes(row.status)) {
      throw new ProposalError('CONFLICT', `提案状态 ${row.status} 不能采纳（需 awaiting_confirm/queued）`)
    }

    const now = this.now()
    const next = { ...proposal, accepted_at: now, accepted_by: opts.acceptedBy.trim(), blocked_by: null }
    this.db
      .prepare("UPDATE work_items SET status = 'done', metadata = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_confirm','queued')")
      .run(JSON.stringify({ proposal: next }), now, id)
    const updated = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Record<string, unknown>
    this.promoteBlocked(id)
    logger.info(`proposal ${id}: accepted by ${opts.acceptedBy} (online 图未改动)`)
    return { row: updated, reused: false }
  }

  /** 驳回：必带理由；只改提案状态，不触碰 online 图。 */
  reject(id: string, opts: { reason: string; rejectedBy?: string }): { row: Record<string, unknown>; reused: boolean } {
    if (!opts.reason || opts.reason.trim() === '') {
      throw new ProposalError('INVALID', '驳回必须填写理由')
    }
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as ({ status: ProposalStatus } & ProposalMetaRow) | undefined
    if (!row) throw new ProposalError('NOT_FOUND', `提案不存在：${id}`)
    const proposal = parseProposal(row.metadata)
    if (!proposal) throw new ProposalError('INVALID', `work_item ${id} 不是提案（缺 metadata.proposal）`)
    if (row.status === 'cancelled') return { row: row as unknown as Record<string, unknown>, reused: true }
    if (!NON_TERMINAL_STATUSES.includes(row.status)) {
      throw new ProposalError('CONFLICT', `提案状态 ${row.status} 不能驳回`)
    }

    const now = this.now()
    const next = {
      ...proposal,
      rejected_at: now,
      rejected_by: opts.rejectedBy?.trim() || null,
      reject_reason: opts.reason.trim(),
      blocked_by: null,
    }
    this.db
      .prepare(
        `UPDATE work_items SET status = 'cancelled', cancel_reason = 'user', metadata = ?, updated_at = ?
          WHERE id = ? AND status IN ('draft','awaiting_confirm','queued','blocked')`,
      )
      .run(JSON.stringify({ proposal: next }), now, id)
    const updated = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Record<string, unknown>
    this.promoteBlocked(id)
    logger.info(`proposal ${id}: rejected (${opts.reason})`)
    return { row: updated, reused: false }
  }

  /** 阻塞超时（>24h）自动取消；返回处理条数。 */
  expireStale(nowMs = Date.now()): number {
    const cutoff = new Date(nowMs - PROPOSAL_BLOCKED_TIMEOUT_MS).toISOString()
    const rows = this.db
      .prepare(
        `SELECT id, metadata FROM work_items
          WHERE status = 'blocked' AND is_current = 1
            AND json_extract(metadata, '$.proposal') IS NOT NULL
            AND updated_at < ?`,
      )
      .all(cutoff) as Array<{ id: string; metadata: string | null }>
    if (rows.length === 0) return 0
    const now = this.now()
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        const proposal = parseProposal(row.metadata)
        if (!proposal) continue
        const next = { ...proposal, rejected_at: now, reject_reason: 'waiting_timeout', blocked_by: null }
        this.db
          .prepare(
            "UPDATE work_items SET status = 'cancelled', cancel_reason = 'user', metadata = ?, updated_at = ? WHERE id = ? AND status = 'blocked'",
          )
          .run(JSON.stringify({ proposal: next }), now, row.id)
        this.promoteBlocked(row.id)
      }
    })
    txn()
    logger.info(`proposal expiry: cancelled ${rows.length} blocked proposal(s)`)
    return rows.length
  }

  /** 前序终态后，提升同 conflict_group 的阻塞提案（每个组只提升一个 open）。 */
  private promoteBlocked(closedId: string): void {
    const blocked = this.db
      .prepare(
        `SELECT id, graph_id, metadata FROM work_items
          WHERE status = 'blocked' AND is_current = 1
            AND json_extract(metadata, '$.proposal') IS NOT NULL
          ORDER BY created_at ASC`,
      )
      .all() as Array<{ id: string; graph_id: string; metadata: string | null }>
    if (blocked.length === 0) return
    const now = this.now()
    for (const row of blocked) {
      const proposal = parseProposal(row.metadata)
      if (!proposal) continue
      if (proposal.blocked_by !== closedId) continue
      // 只有当前组没有 open 提案时才提升，避免并发提升出第二个 open。
      const group = proposal.conflict_group
      const open = this.db
        .prepare(
          `SELECT id FROM work_items
            WHERE graph_id = ? AND is_current = 1
              AND status IN ('awaiting_confirm','queued')
              AND json_extract(metadata, '$.proposal') IS NOT NULL
              ${group ? "AND json_extract(metadata, '$.proposal.conflict_group') = ?" : ''}
            LIMIT 1`,
        )
        .get(...(group ? [row.graph_id, group] : [row.graph_id])) as { id: string } | undefined
      if (open) continue
      const next = { ...proposal, blocked_by: null }
      this.db
        .prepare("UPDATE work_items SET status = 'awaiting_confirm', metadata = ?, updated_at = ? WHERE id = ? AND status = 'blocked'")
        .run(JSON.stringify({ proposal: next }), now, row.id)
      logger.info(`proposal ${row.id}: promoted from blocked (predecessor ${closedId} closed)`)
    }
  }
}

/** 仅供测试/调用方判断：状态是否属于提案 open 集合。 */
export function isOpenProposalStatus(status: unknown): boolean {
  return isProposalStatus(status) && OPEN_STATUSES.includes(status)
}
