/**
 * I.8.F P2：C2 执行中修订的只读投影（历史读通道 + 字段级 diff + impact）。
 *
 * 写路径不变：仍是 `workitem:revise`。本模块只做服务端计算，renderer 只渲染：
 * 1) `listWorkItemRevisions`：按 lineage 读全部 revision（旧行仍在库，此前只有
 *    `is_current = 1` 的读通道）；不改 `is_current` 语义。
 * 2) `buildWorkItemDiff`：字段级 before/after + impact 三项。既可对比两条已落库
 *    revision，也可对比「当前 revision vs 拟修订内容」（此时 gate 结论是预检，
 *    复用生产 gate 引擎，不猜）。
 *
 * impact 口径（P2 裁决）只做三项可推导内容：
 * - 写域文件：`scope_files` 集合差 → added/removed/unchanged；
 *   「文件是否真会被改动」无数据来源（需 run 产 change_set），标 missing。
 * - 验收条目：按条目 id 配对 → added/removed/modified；条目缺稳定 id 或 id 重复
 *   时整体标 missing（不按位置硬配）。
 * - 依赖引用：只算 `depends_on_json` 增删；「哪些 run 失效 / 哪些证据 stale」
 *   无数据来源（revise 不产生失效标记），标 missing。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { normalizeAcceptanceInput, type WorkItemRow } from './work-item-service'

/** 操作审计 kind。写入前先探测表的值域是否接受该值，不接受就如实「未留痕」。 */
export const REVISE_AUDIT_KIND = 'workitem_revise'

export interface WorkItemRevisionSummary {
  id: string
  revision: number
  is_current: boolean
  supersedes_id: string | null
  status: string
  gate_status: string
  title: string
  created_at: string
  updated_at: string
}

export interface FieldDiff {
  field: string
  before: unknown
  after: unknown
  changed: boolean
}

export interface ImpactItem {
  kind: 'writeScope' | 'acceptance' | 'dependency'
  status: 'derived' | 'missing'
  detail: Record<string, unknown>
  /** 该影响面里推不出的具体事实（即使 status=derived 也可能有）。 */
  missing: string[]
  note: string
}

export interface GatePrecheck {
  status: 'stored' | 'precheck'
  gateStatus: string
  missing: string[]
}

export interface ReasonTrace {
  sink: string | null
  note: string
}

export interface WorkItemDiffResult {
  lineageId: string
  from: { id: string; revision: number }
  to: { id: string | null; revision: number; stored: boolean }
  fields: FieldDiff[]
  impact: ImpactItem[]
  gateResult: GatePrecheck
  reasonTrace: ReasonTrace
}

export interface ProposedRevision {
  title?: string
  goal?: string | null
  scopeFiles?: string[]
  acceptance?: Array<Record<string, unknown>>
  dependsOn?: string[]
  verificationHint?: string | null
}

export interface WorkItemDiffInput {
  lineageId: string
  from: number
  /** 对比两条已落库 revision（stored 模式）。 */
  to?: number
  /** 对比「当前 revision vs 拟修订内容」（precheck 模式）。 */
  proposed?: ProposedRevision
}

/** 与字段 diff 顺序一致：只对比计划内容字段，不把 status/gate 生命周期混进 diff。 */
const DIFF_FIELDS = [
  'title',
  'goal',
  'scope_files',
  'out_of_scope_files',
  'acceptance_json',
  'verification_hint',
  'depends_on_json',
] as const

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

type ParseResult<T> = { ok: true; value: T } | { ok: false }

function parseStringArray(raw: string | null | undefined): ParseResult<string[]> {
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return { ok: false }
    return { ok: true, value: parsed as string[] }
  } catch {
    return { ok: false }
  }
}

function parseArray(raw: string | null | undefined): ParseResult<Array<Record<string, unknown>>> {
  if (raw === null || raw === undefined) return { ok: true, value: [] }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { ok: false }
    return { ok: true, value: parsed as Array<Record<string, unknown>> }
  } catch {
    return { ok: false }
  }
}

function parseMissing(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseField(field: (typeof DIFF_FIELDS)[number], value: string | null): unknown {
  if (field === 'scope_files' || field === 'out_of_scope_files' || field === 'depends_on_json') {
    const parsed = parseStringArray(value)
    return parsed.ok ? parsed.value : value
  }
  if (field === 'acceptance_json') {
    const parsed = parseArray(value)
    return parsed.ok ? parsed.value : value
  }
  return value
}

/** 按 lineage 列出全部 revision（含已 superseded 的旧行）。 */
export function listWorkItemRevisions(db: BetterSqlite3.Database, lineageId: string): WorkItemRevisionSummary[] {
  const rows = db
    .prepare(
      `SELECT id, revision, is_current, supersedes_id, status, gate_status, title, created_at, updated_at
         FROM work_items WHERE lineage_id = ? ORDER BY revision ASC`,
    )
    .all(lineageId) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    id: String(row.id),
    revision: Number(row.revision),
    is_current: Number(row.is_current) === 1,
    supersedes_id: typeof row.supersedes_id === 'string' ? row.supersedes_id : null,
    status: String(row.status),
    gate_status: String(row.gate_status),
    title: String(row.title),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }))
}

function getRevision(db: BetterSqlite3.Database, lineageId: string, revision: number): WorkItemRow | undefined {
  return db
    .prepare('SELECT * FROM work_items WHERE lineage_id = ? AND revision = ?')
    .get(lineageId, revision) as WorkItemRow | undefined
}

function buildFields(before: WorkItemRow, after: WorkItemRow): FieldDiff[] {
  return DIFF_FIELDS.map((field) => {
    const beforeValue = parseField(field, before[field] as string | null)
    const afterValue = parseField(field, after[field] as string | null)
    return {
      field,
      before: beforeValue,
      after: afterValue,
      changed: stableStringify(beforeValue) !== stableStringify(afterValue),
    }
  })
}

function writeScopeImpact(before: WorkItemRow, after: WorkItemRow): ImpactItem {
  const beforeScope = parseStringArray(before.scope_files)
  const afterScope = parseStringArray(after.scope_files)
  if (!beforeScope.ok || !afterScope.ok) {
    return {
      kind: 'writeScope',
      status: 'missing',
      detail: {},
      missing: ['scope_files_unparsable'],
      note: 'scope_files 不是合法字符串数组，无法推导写域差异',
    }
  }
  const beforeSet = new Set(beforeScope.value)
  const afterSet = new Set(afterScope.value)
  const added = [...afterSet].filter((file) => !beforeSet.has(file)).sort()
  const removed = [...beforeSet].filter((file) => !afterSet.has(file)).sort()
  const unchanged = [...beforeSet].filter((file) => afterSet.has(file)).sort()
  return {
    kind: 'writeScope',
    status: 'derived',
    detail: { added, removed, unchanged },
    missing: ['filesActuallyChanged'],
    note: '文件是否真会被改动需 run 产出 change_set，当前无数据来源',
  }
}

function acceptanceImpact(before: WorkItemRow, after: WorkItemRow): ImpactItem {
  const beforeAcc = parseArray(before.acceptance_json)
  const afterAcc = parseArray(after.acceptance_json)
  if (!beforeAcc.ok || !afterAcc.ok) {
    return {
      kind: 'acceptance',
      status: 'missing',
      detail: {},
      missing: ['acceptance_json_unparsable'],
      note: 'acceptance_json 不是合法数组，无法推导验收条目差异',
    }
  }
  const all = [...beforeAcc.value, ...afterAcc.value]
  for (const entry of all) {
    const id = entry?.['id']
    if (typeof id !== 'string' || id.trim() === '') {
      return {
        kind: 'acceptance',
        status: 'missing',
        detail: {},
        missing: ['acceptance_entry_without_stable_id'],
        note: '验收条目缺稳定 id，不做按位置的近似配对',
      }
    }
  }
  const beforeMap = new Map(beforeAcc.value.map((entry) => [String(entry['id']), entry]))
  const afterMap = new Map(afterAcc.value.map((entry) => [String(entry['id']), entry]))
  if (beforeMap.size !== beforeAcc.value.length || afterMap.size !== afterAcc.value.length) {
    return {
      kind: 'acceptance',
      status: 'missing',
      detail: {},
      missing: ['acceptance_entry_duplicate_id'],
      note: '验收条目 id 重复，无法确定性配对',
    }
  }
  const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id)).sort()
  const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id)).sort()
  const modified = [...beforeMap.keys()]
    .filter((id) => afterMap.has(id) && stableStringify(beforeMap.get(id)) !== stableStringify(afterMap.get(id)))
    .sort()
  return {
    kind: 'acceptance',
    status: 'derived',
    detail: { added, removed, modified },
    missing: [],
    note: '按条目 id 配对；modified 为除 id 外内容有变化的条目',
  }
}

function dependencyImpact(before: WorkItemRow, after: WorkItemRow): ImpactItem {
  const beforeDep = parseStringArray(before.depends_on_json)
  const afterDep = parseStringArray(after.depends_on_json)
  if (!beforeDep.ok || !afterDep.ok) {
    return {
      kind: 'dependency',
      status: 'missing',
      detail: {},
      missing: ['depends_on_json_unparsable'],
      note: 'depends_on_json 不是合法字符串数组，无法推导依赖变化',
    }
  }
  const beforeSet = new Set(beforeDep.value)
  const afterSet = new Set(afterDep.value)
  const added = [...afterSet].filter((id) => !beforeSet.has(id)).sort()
  const removed = [...beforeSet].filter((id) => !afterSet.has(id)).sort()
  return {
    kind: 'dependency',
    status: 'derived',
    detail: { added, removed },
    missing: ['invalidatedRuns', 'staleEvidence'],
    note: '哪些 run 会失效、哪些证据会 stale 无数据来源（revise 不产生失效标记）',
  }
}

/** 把拟修订内容合到旧行上（只改计划内容字段，不落库）。 */
function applyProposed(base: WorkItemRow, proposed: ProposedRevision): WorkItemRow {
  const next: WorkItemRow = { ...base }
  if (proposed.title !== undefined) next.title = proposed.title.trim()
  if (proposed.goal !== undefined) next.goal = proposed.goal
  if (proposed.scopeFiles !== undefined) next.scope_files = JSON.stringify(proposed.scopeFiles)
  if (proposed.verificationHint !== undefined) next.verification_hint = proposed.verificationHint
  if (proposed.dependsOn !== undefined) next.depends_on_json = JSON.stringify(proposed.dependsOn)
  if (proposed.acceptance !== undefined) {
    // 与 revise 走同一套结构化校验：不合法即抛，不产出「看起来能提交」的 diff。
    next.acceptance_json = JSON.stringify(normalizeAcceptanceInput(proposed.acceptance))
  }
  return next
}

/** 写库前探测审计表是否接受 `workitem_revise`；不接受就如实返回「未留痕」。 */
export function probeReviseReasonSink(db: BetterSqlite3.Database): ReasonTrace {
  let row: { sql: string } | undefined
  try {
    row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'map_migration_reports'")
      .get() as { sql: string } | undefined
  } catch {
    return { sink: null, note: '读取审计表定义失败，修订原因未留痕' }
  }
  if (!row) return { sink: null, note: '审计表 map_migration_reports 不存在，修订原因未留痕' }
  if (!row.sql.includes(`'${REVISE_AUDIT_KIND}'`)) {
    return {
      sink: null,
      note: `审计表 kind 值域不含 ${REVISE_AUDIT_KIND}，修订原因未留痕（未做 schema 变更）`,
    }
  }
  return { sink: 'map_migration_reports', note: '修订原因写入 map_migration_reports 操作审计行' }
}

/**
 * 记录修订原因（best-effort）：审计表值域不接受该 kind 时不写入、不报错，
 * 由调用方把 `traced=false` + note 如实展示为「未留痕」。
 */
export function recordReviseReason(
  db: BetterSqlite3.Database,
  input: { lineageId: string; from: number; to: number; reason: string },
): { traced: boolean; sink: string | null; note: string } {
  const trace = probeReviseReasonSink(db)
  if (!trace.sink) return { traced: false, ...trace }
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO map_migration_reports (id, kind, stage, started_at, finished_at, status, stats_json)
       VALUES (?, ?, ?, ?, ?, 'ok', ?)`,
    ).run(
      `mrr_${Date.now()}_${randomUUID().slice(0, 8)}`,
      REVISE_AUDIT_KIND,
      `workitem_revise:${input.lineageId}:r${input.from}->r${input.to}`,
      now,
      now,
      JSON.stringify({ lineageId: input.lineageId, from: input.from, to: input.to, reason: input.reason }),
    )
    return { traced: true, ...trace }
  } catch (err) {
    return { traced: false, sink: null, note: `写入审计行失败：${err instanceof Error ? err.message : String(err)}（未留痕）` }
  }
}

/**
 * 计算 diff + impact。`to` 与 `proposed` 二选一：
 * - `to`：两条已落库 revision 对比，gate 结论取目标 revision 落库的 gate_status；
 * - `proposed`：旧 revision vs 拟修订内容，gate 结论走生产 gate 引擎预检。
 */
export function buildWorkItemDiff(
  db: BetterSqlite3.Database,
  gate: { recheck(item: WorkItemRow): { ok: boolean; missing: string[] } },
  input: WorkItemDiffInput,
): WorkItemDiffResult {
  const base = getRevision(db, input.lineageId, input.from)
  if (!base) throw new Error(`work item lineage ${input.lineageId} revision ${input.from} 不存在`)
  if (input.to !== undefined && input.proposed !== undefined) {
    throw new Error('to 与 proposed 不能同时提供（一个是历史对比，一个是拟修订预检）')
  }

  let after: WorkItemRow
  let stored: boolean
  let gateResult: GatePrecheck

  if (input.to !== undefined) {
    const target = getRevision(db, input.lineageId, input.to)
    if (!target) throw new Error(`work item lineage ${input.lineageId} revision ${input.to} 不存在`)
    after = target
    stored = true
    gateResult = {
      status: 'stored',
      gateStatus: target.gate_status,
      missing: parseMissing(target.gate_missing_json),
    }
  } else if (input.proposed) {
    after = applyProposed(base, input.proposed)
    stored = false
    const precheck = gate.recheck(after)
    gateResult = {
      status: 'precheck',
      gateStatus: precheck.ok ? 'pass' : 'incomplete',
      missing: precheck.missing,
    }
  } else {
    throw new Error('需要 to（历史对比）或 proposed（拟修订预检）之一')
  }

  return {
    lineageId: input.lineageId,
    from: { id: base.id, revision: base.revision },
    to: {
      id: stored ? after.id : null,
      revision: stored ? after.revision : base.revision + 1,
      stored,
    },
    fields: buildFields(base, after),
    impact: [writeScopeImpact(base, after), acceptanceImpact(base, after), dependencyImpact(base, after)],
    gateResult,
    reasonTrace: probeReviseReasonSink(db),
  }
}
