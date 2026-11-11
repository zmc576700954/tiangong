/**
 * C1 计划草稿级预检投影（I.8.F 的 P1）。
 *
 * 问题：草稿阶段 `work_items` 尚未生成，`gateMissing` 没有真实值，C1 的必填展示项
 * 只能靠 renderer 拼装——那等于在渲染层复算准入，正是 G8-3 明令禁止的做法。
 *
 * 口径（复用，不另写判据）：
 * - 把每条草稿 item 投影成一个**合成 `WorkItemRow`**，直接交给生产同一个
 *   `createGateEngine`（同一工厂、同一份 `readG4Config()`、同一个行数代理）判定；
 *   G1/G2/G3/G4/G6 的缺失码逐字来自引擎输出，本模块不改写、不补充、不排序。
 * - **G5 显式跳过**：草稿的 `dependsOn` 是 plan item key，不是 `work_items.id`；
 *   把它们塞给引擎只会得到一堆假的 `dep_missing`。G5 与环检测在 confirm 之后
 *   由执行侧 gate 再次判定，这里只登记「未判定」及原因，不伪造通过。
 * - 只读：不落库、不缓存、不改 `work_items` / `plan_drafts`。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { GateRecheck } from './gate-recheck'
import type { PlanDraftRow, PlanItem } from './plan-derivation'
import type { WorkItemRow } from './work-item-service'

/** 草稿阶段无法判定、且必须让调用方知道的 gate。 */
export const DRAFT_SKIPPED_GATES = [
  {
    gate: 'G5' as const,
    reason: '草稿依赖是 plan item key，不是 work_items.id；G5 与环检测在 confirm 后由执行侧 gate 判定',
  },
]

export interface DraftGateItemInput {
  draft: PlanDraftRow
  item: PlanItem
  key: string
}

/**
 * 草稿 item → 合成 `WorkItemRow`。
 *
 * 只填 gate 引擎实际读取的字段（其余给保守默认）；`depends_on_json` 固定 `[]`，
 * 理由见文件头的 G5 跳过说明——不能让引擎把 plan key 当 work_item id 去查。
 */
export function buildDraftGateItem(input: DraftGateItemInput): WorkItemRow {
  const { draft, item, key } = input
  return {
    id: `draft:${draft.id}:${key}`,
    lineage_id: draft.lineage_id,
    revision: draft.revision,
    supersedes_id: null,
    is_current: 1,
    project_path: draft.project_path,
    graph_id: draft.graph_id,
    anchor_entity_key: draft.anchor_entity_key,
    anchor_node_id: draft.anchor_node_id,
    parent_work_item_id: null,
    depth: 0,
    title: item.title,
    goal: item.goal ?? null,
    scope_files: JSON.stringify(item.scopeFiles ?? []),
    out_of_scope_files: null,
    acceptance_json: JSON.stringify(item.acceptance ?? []),
    priority: null,
    verification_hint: null,
    status: 'draft',
    cancel_reason: null,
    gate_status: 'incomplete',
    gate_missing_json: null,
    gate_waived_by: null,
    gate_waived_at: null,
    gate_waive_reason: null,
    depends_on_json: '[]',
    origin: 'derived_plan',
    plan_id: draft.id,
    candidate_id: null,
    created_by: null,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    archived_at: null,
  }
}

export interface DraftGateItemResult {
  key: string
  ok: boolean
  /** 引擎原样输出的缺失码（G1/G2/G3/G4/G6）。 */
  missing: string[]
}

export interface DraftGatePrecheck {
  items: DraftGateItemResult[]
  /** 全部条目缺失码的并集（带 `key:` 前缀，便于界面定位到条目）。 */
  missing: string[]
  skipped: typeof DRAFT_SKIPPED_GATES
}

/** 逐条目跑生产 gate 引擎；引擎异常按 fail-closed 记 `gate_engine_unavailable`。 */
export function precheckDraftItems(
  draft: PlanDraftRow,
  items: PlanItem[],
  keys: string[],
  gate: GateRecheck,
): DraftGatePrecheck {
  const results: DraftGateItemResult[] = items.map((item, index) => {
    const key = keys[index]
    try {
      const result = gate.recheck(buildDraftGateItem({ draft, item, key }))
      return { key, ok: result.ok, missing: [...result.missing] }
    } catch {
      return { key, ok: false, missing: ['gate_engine_unavailable'] }
    }
  })
  const missing = results.flatMap((item) => item.missing.map((code) => `${item.key}: ${code}`))
  return { items: results, missing, skipped: DRAFT_SKIPPED_GATES }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

function envelope(items: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { count: items.length, items, ...extra }
}

/** 8 个 C1 必填展示项（§5.6）的服务端投影；全部为对象信封，空也是合法展示结果。 */
export function buildC1Display(
  db: BetterSqlite3.Database,
  draft: PlanDraftRow,
  items: PlanItem[],
  keys: string[],
  precheck: DraftGatePrecheck,
): Record<string, unknown> {
  return {
    subtasks: envelope(
      items.map((item, index) => ({
        key: keys[index],
        title: item.title,
        goal: item.goal ?? null,
        dependsOn: item.dependsOn ?? [],
      })),
    ),
    scopeFiles: envelope([...new Set(items.flatMap((item) => item.scopeFiles ?? []))].sort()),
    acceptance: envelope(
      items.map((item, index) => ({ key: keys[index], entries: item.acceptance ?? [] })),
    ),
    dependencies: envelope(
      items.flatMap((item, index) =>
        (item.dependsOn ?? []).map((dep) => ({ from: keys[index], to: dep })),
      ),
    ),
    candidateScore: candidateScoreDisplay(db, draft),
    gateMissing: envelope(precheck.missing, { skippedGates: precheck.skipped }),
    excludedItems: excludedItemsDisplay(draft),
    anchorStates: anchorStatesDisplay(db, draft),
  }
}

/**
 * 候选得分：`boundary_candidates`（蓝图称 `plan_candidates`，实际表名如此）按
 * `derivation_run_id` 取整批。没有 run id 时如实返回空批，不猜。
 */
function candidateScoreDisplay(db: BetterSqlite3.Database, draft: PlanDraftRow): Record<string, unknown> {
  if (!draft.derivation_run_id) {
    return envelope([], { derivationRunId: null, note: '该草稿未关联推导批次（无 derivation_run_id）' })
  }
  let rows: Array<{ id: string; score: number; confidence: number | null; status: string }> = []
  try {
    rows = db
      .prepare(
        `SELECT id, score, confidence, status FROM boundary_candidates
          WHERE derivation_run_id = ? ORDER BY score DESC, id ASC`,
      )
      .all(draft.derivation_run_id) as typeof rows
  } catch {
    return envelope([], { derivationRunId: draft.derivation_run_id, note: '候选表查询失败' })
  }
  return envelope(
    rows.map((row) => ({ id: row.id, score: row.score, confidence: row.confidence, status: row.status })),
    { derivationRunId: draft.derivation_run_id },
  )
}

/**
 * 被剔除边界：列是 `rejected_boundaries_json`，**当前没有写入方**（只有 DDL 与类型）。
 * 因此正常情况下为空；能解析的条目原样给出，解析不了的只计数，不猜语义。
 */
function excludedItemsDisplay(draft: PlanDraftRow): Record<string, unknown> {
  const parsed = parseJson(draft.rejected_boundaries_json)
  if (!Array.isArray(parsed)) {
    return envelope([], {
      source: 'rejected_boundaries_json',
      unparsed: draft.rejected_boundaries_json ? 1 : 0,
      note: draft.rejected_boundaries_json ? '该列内容不是数组，无法映射' : '无剔除记录',
    })
  }
  const items = parsed.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
  return envelope(items, {
    source: 'rejected_boundaries_json',
    unparsed: parsed.length - items.length,
  })
}

/**
 * 锚点派生状态：草稿锚点 + 候选节点，逐个 join `node_execution_state`。
 * 缓存未算出的节点单独列在 `missing`，不按 `untouched` 冒充。
 */
function anchorStatesDisplay(db: BetterSqlite3.Database, draft: PlanDraftRow): Record<string, unknown> {
  const entityKeys = new Set<string>()
  if (draft.anchor_entity_key) entityKeys.add(draft.anchor_entity_key)
  if (draft.anchor_node_id) {
    try {
      const row = db.prepare('SELECT entity_key FROM nodes WHERE id = ?').get(draft.anchor_node_id) as
        | { entity_key: string | null }
        | undefined
      if (row?.entity_key) entityKeys.add(row.entity_key)
    } catch {
      /* nodes 表缺失时只保留草稿上的 entity_key */
    }
  }
  if (draft.derivation_run_id) {
    try {
      const rows = db
        .prepare('SELECT node_keys_json FROM boundary_candidates WHERE derivation_run_id = ?')
        .all(draft.derivation_run_id) as Array<{ node_keys_json: string }>
      for (const row of rows) for (const key of stringArray(parseJson(row.node_keys_json))) entityKeys.add(key)
    } catch {
      /* 候选表缺失时退回草稿锚点 */
    }
  }

  const items: Array<Record<string, unknown>> = []
  const missing: string[] = []
  for (const entityKey of [...entityKeys].sort()) {
    let row:
      | { execution_state: string; evidence_level: string; evidence_count: number; stale_count: number; computed_at: number }
      | undefined
    try {
      row = db
        .prepare(
          `SELECT execution_state, evidence_level, evidence_count, stale_count, computed_at
             FROM node_execution_state WHERE graph_id = ? AND node_entity_key = ?`,
        )
        .get(draft.graph_id, entityKey) as typeof row
    } catch {
      missing.push(entityKey)
      continue
    }
    if (!row) {
      missing.push(entityKey)
      continue
    }
    items.push({
      entityKey,
      executionState: row.execution_state,
      evidenceLevel: row.evidence_level,
      evidenceCount: row.evidence_count,
      staleCount: row.stale_count,
      computedAt: row.computed_at,
    })
  }
  return envelope(items, { missing })
}
