/**
 * S7 计划推导/草稿/偏差（session-map 蓝图 §5.2/§5.5/§5.6/§5.7）
 *
 * 边界推导（确定性、可复现,§5.2）：层级+文件关联+依赖闭包+变更面加权,
 * 权重冷启动 0.35/0.25/0.20/0.15/0.05(无历史 history_hit=0 并归一化);
 * 聚类=文件重叠(Jaccard≥0.3 且同父/父子);候选≤20、单候选文件≤20、
 * 重叠>30% 标 conflict(C1 人工裁决)。
 *
 * 计划草稿(§5.5/§5.6)：draft→awaiting_confirm→confirmed(生成 work_items)/
 * rejected/superseded;C1 环检测硬性——有环拒绝确认不得进队列;Kahn 分层
 * 仅用于排序(本期串行);依赖优先级 explicit>implicit>order。
 *
 * 偏差度量(§5.7)：一次 work_run 终态写一行;actual_file_count 在 change_sets
 * 未采集时为 NULL 不写 0;归因=derivation_version+observed_rule_version+
 * task_type/agent_type。
 */

import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import type { WorkItemService } from './work-item-service'
import type { WorkRunRow } from './work-run-service'

const logger = createLogger('PlanDerivation')

/** §5.2 冷启动权重（D3:不等待历史数据）。 */
export const DERIVATION_WEIGHTS = {
  hierarchy_proximity: 0.35,
  file_cohesion: 0.25,
  dependency_closure: 0.2,
  change_surface: 0.15,
  history_hit: 0.05,
} as const

export const DERIVATION_LIMITS = { maxCandidates: 20, maxFilesPerCandidate: 20, depthLimit: 3, jaccardLink: 0.3, conflictOverlap: 0.3 } as const

export interface BoundaryCandidateRow {
  id: string
  derivation_run_id: string
  derivation_version: string
  project_path: string | null
  graph_id: string
  anchor_entity_key: string | null
  anchor_node_id: string | null
  node_keys_json: string
  files_json: string
  signals_json: string | null
  score: number
  confidence: number | null
  reason: string | null
  status: 'proposed' | 'chosen' | 'rejected' | 'merged'
  created_at: string
}

export interface DeriveResult {
  runId: string
  degraded: false | 'D1-empty-files' | 'D5-anchor-degenerate'
  candidates: BoundaryCandidateRow[]
}

interface DeriveNode {
  id: string
  entity_key: string | null
  parent_id: string | null
  type: string
  depth: number
  files: string[]
  changeHit: number
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** 从 metadata/content/context_refs 提取文件集 F(n)（§5.2 Step 2）。 */
function extractFiles(metadataRaw: string | null, contentRaw: string | null, contextRefsRaw: string | null): string[] {
  const files = new Set<string>()
  try {
    const meta = metadataRaw ? JSON.parse(metadataRaw) : null
    const assoc = meta?.fileAssociations
    if (Array.isArray(assoc)) {
      for (const a of assoc) {
        if (a && typeof a.path === 'string' && a.path !== '') {
          files.add(a.path)
          // directory 展开为前缀（§5.2:file/directory 展开为前缀）
          if (a.type === 'directory') files.add(`${a.path.replace(/\/$/, '')}/`)
        }
      }
    }
  } catch { /* 脏 metadata 忽略该信号 */ }
  try {
    const content = contentRaw ? JSON.parse(contentRaw) : null
    const related = content?.relatedFiles
    if (Array.isArray(related)) {
      for (const r of related) {
        const p = typeof r === 'string' ? r : (r && typeof r.path === 'string' ? r.path : '')
        if (p !== '') files.add(p)
      }
    }
  } catch { /* 脏 content 忽略 */ }
  try {
    const refs = contextRefsRaw ? JSON.parse(contextRefsRaw) : null
    if (Array.isArray(refs)) {
      for (const r of refs) {
        if (r && r.type === 'file' && typeof r.id === 'string' && r.id !== '') files.add(r.id)
      }
    }
  } catch { /* 脏 refs 忽略 */ }
  return [...files]
}

export class BoundaryDerivationService {
  /** derivation_version：推导规则版本(规则/权重变化时递增,§5.7 归因维度)。 */
  static readonly VERSION = '1'

  constructor(private readonly db: BetterSqlite3.Database) {}

  derive(graphId: string, opts?: { anchorNodeId?: string; depthLimit?: number; maxCandidates?: number; changeFiles?: string[] }): DeriveResult {
    const depthLimit = opts?.depthLimit ?? DERIVATION_LIMITS.depthLimit
    const maxCandidates = opts?.maxCandidates ?? DERIVATION_LIMITS.maxCandidates
    const runId = `dr_${Date.now()}_${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()

    const rows = this.db
      .prepare('SELECT id, entity_key, parent_id, type, title, metadata, content, context_refs FROM nodes WHERE graph_id = ?')
      .all(graphId) as Array<Record<string, unknown>>
    const byId = new Map(rows.map((r) => [String(r.id), r]))

    // Step 1 锚定:S0 = anchor ∪ descendants(≤depthLimit);退化锚型直接 D5
    const anchorId = opts?.anchorNodeId
    const anchorRow = anchorId ? byId.get(anchorId) : undefined
    if (anchorRow && (anchorRow.type === 'wiki-page' || anchorRow.type === 'project')) {
      return { runId, degraded: 'D5-anchor-degenerate', candidates: [] }
    }
    const childrenOf = new Map<string | null, string[]>()
    for (const r of rows) {
      const pid = r.parent_id ? String(r.parent_id) : null
      const list = childrenOf.get(pid) ?? []
      list.push(String(r.id))
      childrenOf.set(pid, list)
    }
    const s0: string[] = []
    const collect = (id: string, depth: number): void => {
      if (depth > depthLimit || s0.includes(id)) return
      s0.push(id)
      for (const c of childrenOf.get(id) ?? []) collect(c, depth + 1)
    }
    if (anchorId) collect(anchorId, 0)
    else for (const r of rows) if (r.type !== 'wiki-page' && r.type !== 'project') s0.push(String(r.id))
    if (s0.length === 0) return { runId, degraded: 'D5-anchor-degenerate', candidates: [] }

    // Step 2 文件集
    const depthOf = new Map<string, number>()
    const computeDepth = (id: string, seen = new Set<string>()): number => {
      if (depthOf.has(id)) return depthOf.get(id)!
      if (seen.has(id)) return 0
      seen.add(id)
      const r = byId.get(id)
      const pid = r?.parent_id ? String(r.parent_id) : null
      const d = pid && byId.has(pid) ? computeDepth(pid, seen) + 1 : 0
      depthOf.set(id, d)
      return d
    }

    const nodes: DeriveNode[] = []
    for (const id of s0) {
      const r = byId.get(id)!
      const files = extractFiles(r.metadata as string | null, r.content as string | null, r.context_refs as string | null)
      nodes.push({
        id,
        entity_key: r.entity_key ? String(r.entity_key) : null,
        parent_id: r.parent_id ? String(r.parent_id) : null,
        type: String(r.type),
        depth: computeDepth(id),
        files,
        changeHit: 0,
      })
    }
    if (nodes.every((n) => n.files.length === 0)) {
      return { runId, degraded: 'D1-empty-files', candidates: [] }
    }

    // Step 3 依赖闭包(depth ≤1,dependency/co-change 双向)
    const edges = this.db
      .prepare("SELECT source, target FROM edges WHERE graph_id = ? AND edge_type IN ('dependency','co-change')")
      .all(graphId) as Array<{ source: string; target: string }>
    const s0Set = new Set(s0)
    const closure = new Set(s0)
    for (const e of edges) {
      if (s0Set.has(e.source)) closure.add(e.target)
      if (s0Set.has(e.target)) closure.add(e.source)
    }
    for (const id of closure) {
      if (!s0Set.has(id) && byId.has(id)) {
        const r = byId.get(id)!
        nodes.push({
          id, entity_key: r.entity_key ? String(r.entity_key) : null,
          parent_id: r.parent_id ? String(r.parent_id) : null, type: String(r.type),
          depth: computeDepth(id), files: extractFiles(r.metadata as string | null, r.content as string | null, r.context_refs as string | null),
          changeHit: 0,
        })
      }
    }
    const internalEdges = new Map<string, number>()
    for (const e of edges) {
      if (closure.has(e.source) && closure.has(e.target)) {
        internalEdges.set(e.source, (internalEdges.get(e.source) ?? 0) + 1)
      }
    }

    // Step 4 变更面加权
    const changeFiles = new Set(opts?.changeFiles ?? this.latestChangeFiles(graphId))
    for (const n of nodes) {
      if (n.files.length === 0) { n.changeHit = 0; continue }
      const fset = new Set(n.files)
      let hits = 0
      for (const f of fset) if (changeFiles.has(f)) hits += 1
      n.changeHit = hits / Math.max(1, fset.size)
    }

    // Step 5 聚类:Jaccard≥0.3 且 层级同父或父子 → 同一候选(union-find)
    const fileSets = new Map<string, Set<string>>()
    for (const n of nodes) fileSets.set(n.id, new Set(n.files))
    const parent = new Map<string, string>()
    const find = (x: string): string => {
      const p = parent.get(x) ?? x
      if (p !== x) {
        const rootOfP = find(p)
        parent.set(x, rootOfP)
        return rootOfP
      }
      return x
    }
    const union = (a: string, b: string): void => {
      const ra = find(a); const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    const hierarchyClose = (a: string, b: string): boolean => {
      const na = byId.get(a)!; const nb = byId.get(b)!
      const pa = na.parent_id ? String(na.parent_id) : null
      const pb = nb.parent_id ? String(nb.parent_id) : null
      return pa === pb || pa === b || pb === a
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]; const b = nodes[j]
        if (fileSets.get(a.id)!.size === 0 || fileSets.get(b.id)!.size === 0) continue
        if (jaccard(fileSets.get(a.id)!, fileSets.get(b.id)!) >= DERIVATION_LIMITS.jaccardLink && hierarchyClose(a.id, b.id)) {
          union(a.id, b.id)
        }
      }
    }
    const clusters = new Map<string, DeriveNode[]>()
    for (const n of nodes) {
      const root = find(n.id)
      const list = clusters.get(root) ?? []
      list.push(n)
      clusters.set(root, list)
    }

    // 打分（§5.2 公式;anchorDepth 用候选最小深度近似）
    const anchorDepth = anchorId ? computeDepth(anchorId) : 0
    const candidates: Array<{ nodes: DeriveNode[]; score: number; files: string[] }> = []
    for (const cluster of clusters.values()) {
      const files = [...new Set(cluster.flatMap((n) => n.files))]
      const minDepth = Math.min(...cluster.map((n) => n.depth))
      const hierarchyProximity = Math.max(0, 1 - (minDepth - anchorDepth) / Math.max(1, depthLimit))
      let pairJ = 0; let pairs = 0
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          pairJ += jaccard(fileSets.get(cluster[i].id)!, fileSets.get(cluster[j].id)!)
          pairs += 1
        }
      }
      const fileCohesion = pairs === 0 ? 1 : pairJ / pairs
      let internal = 0
      for (const n of cluster) internal += internalEdges.get(n.id) ?? 0
      const dependencyClosure = Math.min(1, internal / Math.max(1, cluster.length - 1))
      const changeSurface = cluster.reduce((s, n) => s + n.changeHit, 0) / cluster.length
      const score =
        DERIVATION_WEIGHTS.hierarchy_proximity * hierarchyProximity +
        DERIVATION_WEIGHTS.file_cohesion * fileCohesion +
        DERIVATION_WEIGHTS.dependency_closure * dependencyClosure +
        DERIVATION_WEIGHTS.change_surface * changeSurface
      // history_hit 无历史为 0(权重归一化分母不变——按 §5.2 注释:无历史时为 0)
      candidates.push({ nodes: cluster, score, files })
    }

    // Step 6 约束:候选数/单候选文件截断 + 重叠>30% 标 conflict
    candidates.sort((a, b) => b.score - a.score)
    const kept = candidates.slice(0, maxCandidates)
    const fileCover = new Map<string, Set<number>>()
    kept.forEach((c, i) => {
      for (const f of c.files) {
        const s = fileCover.get(f) ?? new Set<number>()
        s.add(i)
        fileCover.set(f, s)
      }
    })
    const conflictFlags = kept.map((c) => {
      if (c.files.length === 0) return false
      let overlapped = 0
      for (const f of c.files) if ((fileCover.get(f)?.size ?? 0) > 1) overlapped += 1
      return overlapped / c.files.length > DERIVATION_LIMITS.conflictOverlap
    })

    const txn = this.db.transaction((): BoundaryCandidateRow[] => {
      const out: BoundaryCandidateRow[] = []
      kept.forEach((c, i) => {
        const band = c.score >= 0.75 ? '建议采纳' : c.score >= 0.5 ? '需人工选择' : '低于阈值,保留供人工查看'
        const id = `bc_${Date.now()}_${randomUUID().slice(0, 8)}`
        this.db
          .prepare(
            `INSERT INTO boundary_candidates (
               id, derivation_run_id, derivation_version, project_path, graph_id,
               anchor_entity_key, anchor_node_id, node_keys_json, files_json, signals_json,
               score, confidence, reason, status, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
          )
          .run(
            id, runId, BoundaryDerivationService.VERSION,
            (this.db.prepare('SELECT project_path FROM graphs WHERE id = ?').get(graphId) as { project_path: string | null } | undefined)?.project_path ?? null,
            graphId,
            anchorRow?.entity_key ? String(anchorRow.entity_key) : null,
            anchorId ?? null,
            JSON.stringify(c.nodes.map((n) => n.entity_key ?? n.id)),
            JSON.stringify(c.files.slice(0, DERIVATION_LIMITS.maxFilesPerCandidate)),
            JSON.stringify({
              band,
              conflict: conflictFlags[i],
              node_count: c.nodes.length,
              hierarchy_proximity_weighted: DERIVATION_WEIGHTS.hierarchy_proximity,
            }),
            c.score,
            conflictFlags[i] ? 0.5 : Math.min(1, c.score),
            band,
            now,
          )
        out.push(this.db.prepare('SELECT * FROM boundary_candidates WHERE id = ?').get(id) as BoundaryCandidateRow)
      })
      return out
    })
    const rowsOut = txn()
    logger.info(`boundary derivation ${runId}: ${rowsOut.length} candidate(s)`)
    return { runId, degraded: false, candidates: rowsOut }
  }

  /** 最近一次变更面（§5.2 Step 4:C=当前 worktree 或最近一次提交 → 取项目最新 change_set）。 */
  private latestChangeFiles(graphId: string): string[] {
    const row = this.db
      .prepare(
        `SELECT cs.files_json FROM change_sets cs
          JOIN graphs g ON g.project_path = cs.project_path
         WHERE g.id = ?
         ORDER BY cs.captured_at DESC LIMIT 1`,
      )
      .get(graphId) as { files_json: string } | undefined
    if (!row) return []
    try {
      const files = JSON.parse(row.files_json) as Array<{ path?: string }>
      return files.map((f) => f.path).filter((p): p is string => typeof p === 'string')
    } catch {
      return []
    }
  }

  /** C1 人工裁决:候选 chosen/rejected。 */
  decideCandidate(id: string, status: 'chosen' | 'rejected' | 'merged'): void {
    this.db.prepare('UPDATE boundary_candidates SET status = ? WHERE id = ?').run(status, id)
  }
}

// ============================================================
// PlanDraftService（§5.5/§5.6）
// ============================================================

export interface PlanDraftRow {
  id: string
  lineage_id: string
  revision: number
  supersedes_id: string | null
  is_current: number
  project_path: string | null
  graph_id: string
  anchor_entity_key: string | null
  anchor_node_id: string | null
  derivation_run_id: string | null
  items_json: string
  model_choice_json: string | null
  rejected_boundaries_json: string | null
  status: 'draft' | 'awaiting_confirm' | 'confirmed' | 'rejected' | 'superseded'
  confirmed_by: string | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

export interface PlanItem {
  key?: string
  title: string
  goal?: string
  scopeFiles?: string[]
  acceptance?: Array<Record<string, unknown>>
  dependsOn?: string[]
}

export class PlanDraftCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`计划依赖存在环:${cycle.join(' → ')}（C1 环检测硬性,§5.5.1）`)
    this.name = 'PlanDraftCycleError'
  }
}

export class PlanDraftConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanDraftConflictError'
  }
}

export function itemKeys(items: PlanItem[]): string[] {
  return items.map((it, i) => it.key ?? `item-${i + 1}`)
}

/** 环检测（§5.5.1 硬性）：DFS 找环,返回环路径;无环返回 null。 */
export function detectCycle(keys: string[], depends: Map<string, string[]>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  let cycle: string[] | null = null
  const visit = (k: string): void => {
    if (cycle) return
    state.set(k, 1)
    stack.push(k)
    for (const d of depends.get(k) ?? []) {
      if (!keys.includes(d)) continue
      const st = state.get(d) ?? 0
      if (st === 1) {
        cycle = [...stack.slice(stack.indexOf(d)), d]
        return
      }
      if (st === 0) visit(d)
    }
    stack.pop()
    state.set(k, 2)
  }
  for (const k of keys) if ((state.get(k) ?? 0) === 0) visit(k)
  return cycle
}

/** Kahn 分层（§5.5.1:确认后分层,层内稳定顺序;本期串行,层号仅用于排序）。 */
export function kahnLayers(keys: string[], depends: Map<string, string[]>): string[][] {
  const keySet = new Set(keys)
  const indeg = new Map<string, number>(keys.map((k) => [k, 0]))
  const dependents = new Map<string, string[]>()
  for (const k of keys) {
    for (const d of depends.get(k) ?? []) {
      if (!keySet.has(d)) continue
      indeg.set(k, (indeg.get(k) ?? 0) + 1)
      const list = dependents.get(d) ?? []
      list.push(k)
      dependents.set(d, list)
    }
  }
  const layers: string[][] = []
  let frontier = keys.filter((k) => (indeg.get(k) ?? 0) === 0)
  let done = 0
  while (frontier.length > 0) {
    layers.push(frontier)
    done += frontier.length
    const next: string[] = []
    for (const k of frontier) {
      for (const dep of dependents.get(k) ?? []) {
        indeg.set(dep, (indeg.get(dep) ?? 0) - 1)
        if ((indeg.get(dep) ?? 0) === 0) next.push(dep)
      }
    }
    frontier = next
  }
  if (done < keys.length) throw new PlanDraftCycleError(['kahn-incomplete'])
  return layers
}

export class PlanDraftService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly workItems: WorkItemService,
  ) {}

  get(id: string): PlanDraftRow | undefined {
    return this.db.prepare('SELECT * FROM plan_drafts WHERE id = ?').get(id) as PlanDraftRow | undefined
  }

  createDraft(input: {
    projectPath?: string
    graphId: string
    anchorEntityKey?: string
    anchorNodeId?: string
    derivationRunId?: string
    items: PlanItem[]
  }): PlanDraftRow {
    if (!input.items || input.items.length === 0) {
      throw new PlanDraftConflictError('计划至少需要 1 个子任务')
    }
    const now = new Date().toISOString()
    const id = `pd_${Date.now()}_${randomUUID().slice(0, 8)}`
    const lineageId = `pl_${Date.now()}_${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO plan_drafts (
           id, lineage_id, revision, is_current, project_path, graph_id,
           anchor_entity_key, anchor_node_id, derivation_run_id, items_json, status, created_at, updated_at
         ) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id, lineageId, input.projectPath ?? null, input.graphId,
        input.anchorEntityKey ?? null, input.anchorNodeId ?? null, input.derivationRunId ?? null,
        JSON.stringify(input.items), now, now,
      )
    return this.get(id)!
  }

  submit(id: string): PlanDraftRow {
    return this.transition(id, ['draft'], 'awaiting_confirm')
  }

  reject(id: string): PlanDraftRow {
    return this.transition(id, ['draft', 'awaiting_confirm'], 'rejected')
  }

  /**
   * C1 确认（强制,§5.6）：环检测硬性 → 生成 work_items。
   * 一个计划 = 1 个父任务 + N 个子任务（depends_on 映射为创建后 id）;
   * gate 引擎（G1-G6）未实现——生成的任务落 draft 走人工 gate（§8.1.1 护栏）。
   */
  confirm(id: string, opts?: { confirmedBy?: string }): { draft: PlanDraftRow; workItemIds: string[]; parentId: string } {
    const draft = this.get(id)
    if (!draft) throw new PlanDraftConflictError(`plan_draft ${id} 不存在`)
    const items = JSON.parse(draft.items_json) as PlanItem[]
    const keys = itemKeys(items)
    const depends = new Map<string, string[]>()
    items.forEach((it, i) => depends.set(keys[i], it.dependsOn ?? []))

    // C1 环检测（硬性）
    const cycle = detectCycle(keys, depends)
    if (cycle) throw new PlanDraftCycleError(cycle)
    kahnLayers(keys, depends) // 分层校验(与环检测双保险)

    const now = new Date().toISOString()
    const txn = this.db.transaction((): { draft: PlanDraftRow; workItemIds: string[]; parentId: string } => {
      // 同一 lineage 只要已有 confirmed revision,就不再允许 confirm：否则会生成
      // 第二套 parent+children,而旧的一套仍是 draft。已确认计划在 work_item 层
      // 修订（WorkItemService.revise 自带 running-run 守卫 + supersede + 继承），
      // 计划行本身作为"当时确认了什么"的事实保持只读。
      const confirmedSibling = this.db
        .prepare("SELECT id FROM plan_drafts WHERE lineage_id = ? AND id <> ? AND status = 'confirmed' LIMIT 1")
        .get(draft.lineage_id, id) as { id: string } | undefined
      if (confirmedSibling) {
        throw new PlanDraftConflictError(
          `plan_draft ${id}: lineage ${draft.lineage_id} 已有已确认 revision ${confirmedSibling.id}，不得再次 confirm（会生成第二套 work_items）`,
        )
      }
      const demote = this.db
        .prepare("UPDATE plan_drafts SET status = 'confirmed', is_current = 1, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_confirm' AND is_current = 1")
        .run(opts?.confirmedBy ?? null, now, now, id)
      if (demote.changes !== 1) {
        throw new PlanDraftConflictError(`plan_draft ${id}: confirm 条件更新未命中（CONFLICT）`)
      }
      // 生成 work_items:父任务 + 子任务
      const parent = this.workItems.createDraft({
        projectPath: draft.project_path ?? undefined,
        graphId: draft.graph_id,
        anchorEntityKey: draft.anchor_entity_key ?? undefined,
        anchorNodeId: draft.anchor_node_id ?? undefined,
        title: `计划:${items[0]?.title ?? id}`,
        origin: 'derived_plan',
        createdBy: opts?.confirmedBy,
        steps: items.map((it) => ({ title: it.title, stepKind: 'agent' as const })),
      })
      const keyToId = new Map<string, string>()
      // 按 Kahn 层序创建,保证 depends_on 引用的任务先存在
      const layers = kahnLayers(keys, depends)
      for (const layer of layers) {
        for (const key of layer) {
          const idx = keys.indexOf(key)
          const it = items[idx]
          const child = this.workItems.createDraft({
            projectPath: draft.project_path ?? undefined,
            graphId: draft.graph_id,
            anchorEntityKey: draft.anchor_entity_key ?? undefined,
            anchorNodeId: draft.anchor_node_id ?? undefined,
            parentWorkItemId: parent.id,
            title: it.title,
            goal: it.goal,
            scopeFiles: it.scopeFiles,
            acceptance: it.acceptance,
            dependsOn: (it.dependsOn ?? []).map((d) => keyToId.get(d)).filter((v): v is string => Boolean(v)),
            origin: 'derived_plan',
            createdBy: opts?.confirmedBy,
          })
          keyToId.set(key, child.id)
        }
      }
      return { draft: this.get(id)!, workItemIds: [...keyToId.values()], parentId: parent.id }
    })
    const result = txn()
    logger.info(`plan_draft ${id} confirmed → ${result.workItemIds.length} work_item(s)`)
    return result
  }

  /**
   * 修订（§5.5):新 revision;旧行 superseded。
   * 已确认计划不可修订：confirm 已按其 items 生成 work_items,再修订会得到两套
   * 任务且旧一套仍是 draft。确认后的调整走 work_item 层修订（有 running-run
   * 守卫与 supersede/继承语义），或新建计划草稿（新 lineage）。
   */
  revise(id: string, items: PlanItem[]): PlanDraftRow {
    const now = new Date().toISOString()
    const keys = itemKeys(items)
    const depends = new Map<string, string[]>()
    items.forEach((it, i) => depends.set(keys[i], it.dependsOn ?? []))
    const cycle = detectCycle(keys, depends)
    if (cycle) throw new PlanDraftCycleError(cycle)

    const txn = this.db.transaction((): PlanDraftRow => {
      const old = this.get(id)
      if (!old) throw new PlanDraftConflictError(`plan_draft ${id} 不存在`)
      if (old.is_current !== 1) throw new PlanDraftConflictError('只能修订当前 revision')
      if (old.status === 'confirmed') {
        throw new PlanDraftConflictError(
          `plan_draft ${id} 已确认（已生成 work_items），不可再修订；请在 work_item 层修订或新建计划草稿`,
        )
      }
      const nextStatus = old.status === 'draft' ? 'draft' : 'awaiting_confirm'
      const demote = this.db
        .prepare("UPDATE plan_drafts SET is_current = 0, status = 'superseded', updated_at = ? WHERE id = ? AND is_current = 1")
        .run(now, id)
      if (demote.changes !== 1) throw new PlanDraftConflictError('并发修订冲突')
      const newId = `pd_${Date.now()}_${randomUUID().slice(0, 8)}`
      this.db
        .prepare(
          `INSERT INTO plan_drafts (
             id, lineage_id, revision, supersedes_id, is_current, project_path, graph_id,
             anchor_entity_key, anchor_node_id, derivation_run_id, items_json, status, created_at, updated_at
           ) SELECT ?, lineage_id, revision + 1, ?, 1, project_path, graph_id,
             anchor_entity_key, anchor_node_id, derivation_run_id, ?, ?, ?, ?
           FROM plan_drafts WHERE id = ?`,
        )
        .run(newId, old.id, JSON.stringify(items), nextStatus, now, now, id)
      return this.get(newId)!
    })
    return txn()
  }

  private transition(id: string, from: readonly PlanDraftRow['status'][], to: PlanDraftRow['status']): PlanDraftRow {
    const placeholders = from.map(() => '?').join(',')
    const result = this.db
      .prepare(`UPDATE plan_drafts SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders}) AND is_current = 1`)
      .run(to, new Date().toISOString(), id, ...from)
    if (result.changes !== 1) {
      throw new PlanDraftConflictError(`plan_draft ${id}: → ${to} 条件更新未命中（CONFLICT）`)
    }
    return this.get(id)!
  }
}

// ============================================================
// PlanDeviationRepository（§5.7）
// ============================================================

export interface PlanDeviationRow {
  id: string
  work_item_id: string | null
  work_item_lineage_id: string | null
  work_item_revision: number | null
  work_run_id: string | null
  derivation_version: string
  observed_rule_version: string
  task_type: string
  agent_type: string | null
  planned_file_count: number | null
  actual_file_count: number | null
  planned_subtask_count: number | null
  actual_subtask_count: number | null
  turns_used: number | null
  tool_calls: number | null
  rework_count: number
  test_failures: number
  replan_count: number
  scope_violation: number
  boundary_changed: number
  duration_ms: number | null
  computed_at: number
}

export interface RecordDeviationInput {
  workRunId: string
  derivationVersion: string
  observedRuleVersion: string
  taskType: string
  agentType?: string
  turnsUsed?: number
  toolCalls?: number
  reworkCount?: number
  testFailures?: number
  scopeViolation?: boolean
  boundaryChanged?: boolean
}

export class PlanDeviationRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * 采集时点（§5.7）:run 终态事务提交后写入;actual_file_count 在 change_sets
   * 未采集时为 NULL,不写 0;字段取自 work_items/work_runs/change_sets。
   */
  recordForRun(input: RecordDeviationInput): PlanDeviationRow {
    const run = this.db.prepare('SELECT * FROM work_runs WHERE id = ?').get(input.workRunId) as
      | (WorkRunRow & { work_item_revision: number })
      | undefined
    if (!run) throw new Error(`work_run ${input.workRunId} 不存在`)
    const item = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(run.work_item_id) as
      | { id: string; lineage_id: string; revision: number; scope_files: string; graph_id: string }
      | undefined

    // planned_file_count = 计划 scope_files 数
    let plannedFiles: number | null = null
    if (item) {
      try { plannedFiles = (JSON.parse(item.scope_files) as string[]).length } catch { plannedFiles = null }
    }
    // actual_file_count = change_set 文件数;未采集 → NULL(不写 0)
    let actualFiles: number | null = null
    let boundaryChanged: number = input.boundaryChanged ? 1 : 0
    if (item) {
      const cs = this.db
        .prepare('SELECT files_json, file_count FROM change_sets WHERE work_run_id = ?')
        .get(run.id) as { files_json: string; file_count: number } | undefined
      if (cs) {
        actualFiles = cs.file_count
        if (!input.boundaryChanged) {
          try {
            const planned = JSON.parse(item.scope_files) as string[]
            const actualPaths = (JSON.parse(cs.files_json) as Array<{ path?: string }>).map((f) => f.path ?? '')
            boundaryChanged = planned.length > 0 && !actualPaths.every((p) => planned.includes(p)) ? 1 : 0
          } catch { boundaryChanged = 0 }
        }
      }
    }
    // replan_count = 该 lineage 的 revision 次数
    const replan = item
      ? (this.db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE lineage_id = ?').get(item.lineage_id) as { c: number }).c - 1
      : 0
    // 子任务计数:planned=兄弟子任务数;actual=同父下已有 run 的去重 work_item 数
    let plannedSub: number | null = null
    let actualSub: number | null = null
    if (item) {
      const parent = this.db.prepare('SELECT parent_work_item_id FROM work_items WHERE id = ?').get(item.id) as { parent_work_item_id: string | null } | undefined
      if (parent?.parent_work_item_id) {
        plannedSub = (this.db.prepare('SELECT COUNT(*) AS c FROM work_items WHERE parent_work_item_id = ? AND is_current = 1').get(parent.parent_work_item_id) as { c: number }).c
        actualSub = (this.db.prepare('SELECT COUNT(DISTINCT work_item_id) AS c FROM work_runs WHERE work_item_id IN (SELECT id FROM work_items WHERE parent_work_item_id = ?)').get(parent.parent_work_item_id) as { c: number }).c
      }
    }
    const duration = run.started_at && run.ended_at ? run.ended_at - run.started_at : null

    const id = `pdev_${Date.now()}_${randomUUID().slice(0, 8)}`
    this.db
      .prepare(
        `INSERT INTO plan_deviations (
           id, work_item_id, work_item_lineage_id, work_item_revision, work_run_id,
           derivation_version, observed_rule_version, task_type, agent_type,
           planned_file_count, actual_file_count, planned_subtask_count, actual_subtask_count,
           turns_used, tool_calls, rework_count, test_failures, replan_count,
           scope_violation, boundary_changed, duration_ms, computed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, run.work_item_id, run.work_item_lineage_id, run.work_item_revision, run.id,
        input.derivationVersion, input.observedRuleVersion, input.taskType, input.agentType ?? null,
        plannedFiles, actualFiles, plannedSub, actualSub,
        input.turnsUsed ?? null, input.toolCalls ?? null, input.reworkCount ?? 0, input.testFailures ?? 0,
        replan, input.scopeViolation ? 1 : 0, boundaryChanged, duration, Date.now(),
      )
    return this.db.prepare('SELECT * FROM plan_deviations WHERE id = ?').get(id) as PlanDeviationRow
  }
}
