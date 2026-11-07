/**
 * S1.3 entity_key 旧库回填（session-map 蓝图 §2.2 + §2.2.2 S1-c）
 *
 * 对每个 project_path 配对 online/dev 基准图（多图不参与、只报告），按结构签名
 * 匹配两侧节点并分配 entity_key：
 *  - sig = sha256(type | title_normalized | parent_signature_chain | sibling_ordinal)
 *  - 精确签名组内两侧各 1 个节点才配对；否则 ambiguous 不配对
 *  - 退化匹配 (type, title_normalized, parent_chain)，同样要求两侧各 1 个候选
 *  - 未配对节点（含占位节点）各自分配新 UUID v4
 *  - 幂等：只处理 entity_key IS NULL 的行；UPDATE 带 IS NULL 守卫，
 *    changes=0（并发写入）→ 项目回滚并重试一次，仍失败则 failed
 *  - 每个项目一个事务；单项目失败不回滚已提交的其他项目（可续跑）
 *
 * 唯一索引 ux_nodes_graph_entity_key 在 migrate() 中先于本回填创建（全 NULL 时
 * 合法）：回填产生的重复键会在写入时被索引当场拒绝并使项目事务回滚——与
 * 蓝图"S1.4 冲突 → failed"同一结局，失败面更小。
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { createLogger } from '../shared/logger'
import { runMigrationStage } from './migration-state'

const logger = createLogger('EntityKeyBackfill')

interface NodeRow {
  id: string
  type: string
  title: string
  parent_id: string | null
  sort_index: number | null
  created_at: string
  entity_key: string | null
}

interface SigContext {
  byId: Map<string, NodeRow>
  childrenOf: Map<string | null, NodeRow[]>
  chain: Map<string, string>
  ordinal: Map<string, number>
}

/** 标题规范化：去首尾空白、连续空白折叠；大小写保持不变（中文标题无大小写）。 */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ')
}

function buildSigContext(nodes: NodeRow[]): SigContext {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const childrenOf = new Map<string | null, NodeRow[]>()
  for (const n of nodes) {
    const key = n.parent_id != null && byId.has(n.parent_id) ? n.parent_id : null
    const list = childrenOf.get(key) ?? []
    list.push(n)
    childrenOf.set(key, list)
  }
  // sibling_ordinal：父节点下按 (COALESCE(sort_index, 2147483647), created_at, id) 升序，从 0 起
  const ordinal = new Map<string, number>()
  for (const [, children] of childrenOf) {
    const sorted = [...children].sort((a, b) => {
      const ai = a.sort_index ?? 2147483647
      const bi = b.sort_index ?? 2147483647
      if (ai !== bi) return ai - bi
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    sorted.forEach((n, i) => ordinal.set(n.id, i))
  }
  // parent_signature_chain：从根递归拼接；根为空。chain(子) = chain(父) + '/' + 父组件
  const chain = new Map<string, string>()
  const computeChain = (n: NodeRow): string => {
    const cached = chain.get(n.id)
    if (cached !== undefined) return cached
    const parent = n.parent_id != null ? byId.get(n.parent_id) : undefined
    const value = parent ? `${computeChain(parent)}/${parent.type}:${normalizeTitle(parent.title)}` : ''
    chain.set(n.id, value)
    return value
  }
  for (const n of nodes) computeChain(n)
  return { byId, childrenOf, chain, ordinal }
}

function signatureOf(n: NodeRow, ctx: SigContext): string {
  const component = `${n.type}|${normalizeTitle(n.title)}|${ctx.chain.get(n.id) ?? ''}|${ctx.ordinal.get(n.id) ?? 0}`
  return createHash('sha256').update(component).digest('hex')
}

/** 退化匹配键：不含 sibling_ordinal（同名兄弟歧义在退化层允许存在，但要求唯一候选）。 */
function fallbackKeyOf(n: NodeRow, ctx: SigContext): string {
  return `${n.type}|${normalizeTitle(n.title)}|${ctx.chain.get(n.id) ?? ''}`
}

/** 占位节点：title 为空且 type='project' 的根——不参与跨图配对，各自新键。 */
function isPlaceholder(n: NodeRow): boolean {
  return n.title.trim() === '' && n.type === 'project'
}

interface SideNodes {
  /** 全量行：签名链/兄弟序号的构建必须基于完整树。 */
  nodes: NodeRow[]
  /** 待回填行（entity_key IS NULL）：匹配与分配只作用于该集合（I3 幂等）。 */
  pending: NodeRow[]
  ctx: SigContext
}

function loadSide(db: BetterSqlite3.Database, graphId: string): SideNodes {
  const rows = db
    .prepare('SELECT id, type, title, parent_id, sort_index, created_at, entity_key FROM nodes WHERE graph_id = ?')
    .all(graphId) as NodeRow[]
  return { nodes: rows, pending: rows.filter((n) => n.entity_key == null), ctx: buildSigContext(rows) }
}

export interface ProjectBackfillStats {
  project_path: string
  online_graph: string
  dev_graph: string
  matched_exact: number
  matched_fallback: number
  unmatched: number
  ambiguous: number
  null_before: number
  null_after: number
  duplicate_graphs: string[]
  placeholders: number
}

export interface BackfillRunStats {
  projects_total: number
  projects_ok: number
  projects_failed: number
  matched_exact: number
  matched_fallback: number
  unmatched: number
  ambiguous: number
  null_before: number
  null_after: number
  unmatched_details: Array<{ project_path: string; id: string; type: string; title: string; parent_id: string | null; reason: string }>
}

/** 项目 → online/dev 基准图配对；多余同类型图记入 duplicate_graphs，不参与回填。 */
export function pairProjectGraphs(
  db: BetterSqlite3.Database,
): Array<{ project_path: string; online: string; dev: string; duplicate_graphs: string[] }> {
  const rows = db
    .prepare(
      `SELECT id, type, project_path, created_at FROM graphs
        WHERE project_path IS NOT NULL AND project_path != ''
        ORDER BY project_path ASC, created_at ASC, id ASC`,
    )
    .all() as Array<{ id: string; type: string; project_path: string; created_at: string }>
  const byProject = new Map<string, { online: string[]; dev: string[] }>()
  for (const r of rows) {
    const entry = byProject.get(r.project_path) ?? { online: [], dev: [] }
    if (r.type === 'online') entry.online.push(r.id)
    else if (r.type === 'dev') entry.dev.push(r.id)
    byProject.set(r.project_path, entry)
  }
  const pairs: Array<{ project_path: string; online: string; dev: string; duplicate_graphs: string[] }> = []
  for (const [project_path, entry] of byProject) {
    if (entry.online.length === 0 || entry.dev.length === 0) continue
    pairs.push({
      project_path,
      online: entry.online[0],
      dev: entry.dev[0],
      duplicate_graphs: [...entry.online.slice(1), ...entry.dev.slice(1)],
    })
  }
  return pairs
}

/**
 * 单项目回填：一个事务；UPDATE 带 entity_key IS NULL 守卫，changes=0 → 回滚重试一次。
 */
export function backfillProject(
  db: BetterSqlite3.Database,
  pairing: { project_path: string; online: string; dev: string; duplicate_graphs: string[] },
): ProjectBackfillStats {
  for (let attempt = 0; ; attempt++) {
    try {
      return db.transaction(() => runProjectTxn(db, pairing))()
    } catch (err) {
      if (attempt === 0 && err instanceof ConcurrentWriteError) {
        logger.warn(`project ${pairing.project_path}: concurrent write during backfill, retrying once`)
        continue
      }
      throw err
    }
  }
}

class ConcurrentWriteError extends Error {}

function runProjectTxn(
  db: BetterSqlite3.Database,
  pairing: { project_path: string; online: string; dev: string; duplicate_graphs: string[] },
): ProjectBackfillStats {
  const online = loadSide(db, pairing.online)
  const dev = loadSide(db, pairing.dev)

  const stats: ProjectBackfillStats = {
    project_path: pairing.project_path,
    online_graph: pairing.online,
    dev_graph: pairing.dev,
    matched_exact: 0,
    matched_fallback: 0,
    unmatched: 0,
    ambiguous: 0,
    null_before: 0,
    null_after: 0,
    duplicate_graphs: pairing.duplicate_graphs,
    placeholders: 0,
  }

  const assign = new Map<string, string>() // node id → entity_key
  const unmatchedDetails: Array<{ id: string; type: string; title: string; parent_id: string | null; reason: string }> = []

  // ---- 精确签名匹配：跨图同签名且组内各 1 个节点才配对 ----
  const groupBy = <T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> => {
    const m = new Map<string, T[]>()
    for (const item of items) {
      const k = keyOf(item)
      const list = m.get(k) ?? []
      list.push(item)
      m.set(k, list)
    }
    return m
  }

  const onlineSig = groupBy(online.pending, (n) => signatureOf(n, online.ctx))
  const devSig = groupBy(dev.pending, (n) => signatureOf(n, dev.ctx))
  const excludedOnline = new Set<string>() // 已配对或已判 ambiguous，不再进入退化匹配
  const excludedDev = new Set<string>()

  for (const [sig, oList] of onlineSig) {
    const dList = devSig.get(sig)
    if (!dList) continue
    if (oList.length !== 1 || dList.length !== 1) {
      // 组内多节点 → 记 ambiguous，不配对（S1-c 3）；两侧成员均排除出退化匹配
      for (const n of oList) {
        if (!isPlaceholder(n)) {
          stats.ambiguous += 1
          excludedOnline.add(n.id)
        }
      }
      for (const n of dList) {
        if (!isPlaceholder(n)) {
          stats.ambiguous += 1
          excludedDev.add(n.id)
        }
      }
      continue
    }
    const o = oList[0]
    const d = dList[0]
    if (isPlaceholder(o) || isPlaceholder(d)) continue
    const key = randomUUID()
    assign.set(o.id, key)
    assign.set(d.id, key)
    excludedOnline.add(o.id)
    excludedDev.add(d.id)
    stats.matched_exact += 1
  }

  // ---- 退化匹配 (type, title_normalized, parent_chain)：两侧各 1 个未排除候选 ----
  const onlineFallback = groupBy(
    online.pending.filter((n) => !excludedOnline.has(n.id) && !isPlaceholder(n)),
    (n) => fallbackKeyOf(n, online.ctx),
  )
  const devFallback = groupBy(
    dev.pending.filter((n) => !excludedDev.has(n.id) && !isPlaceholder(n)),
    (n) => fallbackKeyOf(n, dev.ctx),
  )
  for (const [fk, oList] of onlineFallback) {
    const dList = devFallback.get(fk)
    if (!dList) continue
    if (oList.length !== 1 || dList.length !== 1) continue // 多候选 → 各自新键
    const key = randomUUID()
    assign.set(oList[0].id, key)
    assign.set(dList[0].id, key)
    excludedOnline.add(oList[0].id)
    excludedDev.add(dList[0].id)
    stats.matched_fallback += 1
  }

  // ---- 占位节点：不参与跨图配对，各自新键（S1-c 6，避免把一个项目的根误配到另一项目）----
  for (const side of [online, dev]) {
    for (const n of side.pending) {
      if (!isPlaceholder(n)) continue
      assign.set(n.id, randomUUID())
      stats.placeholders += 1
    }
  }

  // ---- 未配对（两侧各自新键；同一节点只生成一次）----
  for (const [side, excluded] of [
    [online, excludedOnline],
    [dev, excludedDev],
  ] as const) {
    for (const n of side.pending) {
      if (excluded.has(n.id) || isPlaceholder(n)) continue
      assign.set(n.id, randomUUID())
      stats.unmatched += 1
      unmatchedDetails.push({ id: n.id, type: n.type, title: n.title, parent_id: n.parent_id, reason: 'unmatched' })
    }
  }

  // ---- 落库：只写 NULL 行（I3：已有非空键永不改写）----
  const now = new Date().toISOString()
  const update = db.prepare('UPDATE nodes SET entity_key = ?, updated_at = ? WHERE id = ? AND entity_key IS NULL')
  const nullCount = db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE graph_id IN (?, ?) AND entity_key IS NULL')
  stats.null_before = (nullCount.get(pairing.online, pairing.dev) as { c: number }).c
  for (const [nodeId, key] of assign) {
    const result = update.run(key, now, nodeId)
    if (result.changes === 0) {
      // 被并发写入抢先（该行已有键）——按 S1-c 7 回滚整个项目并重试一次
      throw new ConcurrentWriteError(`node ${nodeId} already has entity_key (concurrent write)`)
    }
  }
  stats.null_after = (nullCount.get(pairing.online, pairing.dev) as { c: number }).c

  ;(stats as ProjectBackfillStats & { unmatched_details: typeof unmatchedDetails }).unmatched_details = unmatchedDetails
  return stats
}

/**
 * S1.3 入口：对所有可配对项目执行回填（每项目一个事务，单项目失败不阻断其他项目，
 * 但整体阶段失败 → 启动阻断）。幂等：只处理 entity_key IS NULL 行。
 */
export function runEntityKeyBackfill(db: BetterSqlite3.Database, schemaVersion: number): BackfillRunStats {
  let aggregate: BackfillRunStats | undefined
  let unmatchedDetails: BackfillRunStats['unmatched_details'] = []
  runMigrationStage(db, {
    kind: 'entity_key_backfill',
    stage: 'S1.backfill',
    schemaVersion,
    work: () => {
      const pairings = pairProjectGraphs(db)
      aggregate = {
        projects_total: pairings.length,
        projects_ok: 0,
        projects_failed: 0,
        matched_exact: 0,
        matched_fallback: 0,
        unmatched: 0,
        ambiguous: 0,
        null_before: 0,
        null_after: 0,
        unmatched_details: [],
      }
      const failedProjects: Array<{ project_path: string; error: string }> = []
      for (const pairing of pairings) {
        try {
          const stats = backfillProject(db, pairing)
          aggregate.projects_ok += 1
          aggregate.matched_exact += stats.matched_exact
          aggregate.matched_fallback += stats.matched_fallback
          aggregate.unmatched += stats.unmatched
          aggregate.ambiguous += stats.ambiguous
          aggregate.null_before += stats.null_before
          aggregate.null_after += stats.null_after
          const details =
            (stats as ProjectBackfillStats & { unmatched_details?: BackfillRunStats['unmatched_details'] }).unmatched_details ?? []
          unmatchedDetails.push(...details.map((d) => ({ ...d, project_path: pairing.project_path })))
        } catch (err) {
          aggregate.projects_failed += 1
          failedProjects.push({
            project_path: pairing.project_path,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (failedProjects.length > 0) {
        // §2.2.2 S1.3：项目失败 → 该项目 failed、整体 S1 阻断（已提交项目保留，可续跑）
        throw new Error(
          `entity_key backfill failed for ${failedProjects.length} project(s): ${failedProjects.map((f) => f.project_path).join(', ')}`,
        )
      }
      return { stats: { ...aggregate, unmatched_details: undefined }, details: { unmatched_details: unmatchedDetails.slice(0, 200) } }
    },
  })
  return aggregate ?? {
    projects_total: 0,
    projects_ok: 0,
    projects_failed: 0,
    matched_exact: 0,
    matched_fallback: 0,
    unmatched: 0,
    ambiguous: 0,
    null_before: 0,
    null_after: 0,
    unmatched_details: [],
  }
}
