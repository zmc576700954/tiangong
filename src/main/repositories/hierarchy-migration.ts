/**
 * 层级结构数据迁移
 *
 * 与 database.ts 的分工（见 design §4.2）：
 * - DDL（加列 / CHECK 约束）由 database.ts 的 runIncrementalMigrations 用 addColumnSafe 负责
 * - 本文件只做数据搬运，不碰 DDL
 *
 * 四步的顺序不可换：
 *   1. 清孤儿     必须先于回填 sort_index —— 否则会给已失效的父子关系排序号
 *   2. 回填 sort_index 必须先于改写 edge_type —— 改写后父子关系才完整
 *   3. default → hierarchical
 *   4. 补齐缺失的 hierarchical 边（修「手动加的子节点没有边」这一存量问题）
 *
 * 幂等：每次启动都会跑，重复执行结果不变。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { generateId } from '../shared/env'

/**
 * 参与兄弟排序的边类型。
 * 迁移前层级边是 'default'，迁移后是 'hierarchical' —— 两者都要认：
 * 库里可能同时存在两种形态的层级边（迁移改写过一批，后续写入路径又直接写
 * 'hierarchical'），只认其一会让仍需回填的子节点退回 created_at 兜底。
 */
const HIERARCHY_EDGE_TYPES = new Set(['default', 'hierarchical'])

/** 回填时子节点的形态 */
interface MigrationChild {
  id: string
  created_at: string | null
  sort_index: number | null
}

/** 已经显式拥有 sort_index 的子节点（用户或 reparent 写进去的值） */
type AssignedChild = MigrationChild & { sort_index: number }

/** 迁移入口：幂等，可在每次启动时安全调用 */
export function runHierarchyMigration(db: BetterSqlite3.Database): void {
  const migrate = db.transaction(() => {
    clearOrphanParentIds(db)
    backfillSortIndex(db)
    rewriteHierarchyEdgeTypes(db)
    insertMissingHierarchyEdges(db)
  })
  migrate()
}

/**
 * 第 1 步：清孤儿。
 * parent_id 指向已删除的节点 → 置 NULL（变成根节点）。
 * 没有这一步，后续按 parent_id 遍历的后代检查会走进死循环。
 *
 * 用 NOT EXISTS 而不是 NOT IN：nodes.id 是 TEXT PRIMARY KEY，SQLite 允许 NULL 主键；
 * NOT IN 的集合里只要有一个 NULL，整个谓词对每一行都变成 NULL（不是 true），
 * 一个孤儿都清不掉 —— 而这一步失败是静默的。
 */
function clearOrphanParentIds(db: BetterSqlite3.Database): void {
  db.prepare(
    `UPDATE nodes SET parent_id = NULL
     WHERE parent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = nodes.parent_id)`,
  ).run()
}

/**
 * 第 2 步：回填 sort_index（兄弟顺序）—— **只补空位，不覆写已有值**。
 *
 * sort_index 是用户可控的兄弟顺序（spec §4.8）：reparent / 兄弟重排会显式写它。
 * 迁移每次启动都跑，若在这里按边顺序重新推导，就会把用户排好的顺序改回去 ——
 * reparent 改的是 parent_id 和 sort_index，而边的 rowid 顺序不会跟着变，
 * 于是「拖拽挂到末尾的子节点」下次启动就会跳到最前。
 *
 * 所以：
 * - 只给 sort_index IS NULL 的子节点赋值，已有值一律不动
 * - 混合态（部分兄弟已有 sort_index）时，新填的从 max(已有) + 1 起步，接在已有值之后
 *
 * toFill 内部的定序规则：
 * - 有 default/hierarchical 边的孩子 → 取该边在「父节点边列表」中的位置（tier 0）
 * - 没有任何边的孩子 → 按 created_at 兜底，排在有边的那批之后（tier 1）
 *
 * 无 parent_id 的节点是根节点，sort_index 保持 NULL（根节点没有兄弟可言）。
 */
function backfillSortIndex(db: BetterSqlite3.Database): void {
  db.prepare('UPDATE nodes SET sort_index = NULL WHERE parent_id IS NULL').run()

  const selectParents = db.prepare(
    'SELECT DISTINCT parent_id FROM nodes WHERE parent_id IS NOT NULL',
  )
  const selectParentEdges = db.prepare(
    'SELECT target, edge_type FROM edges WHERE source = ? ORDER BY rowid',
  )
  const selectChildren = db.prepare(
    'SELECT id, created_at, sort_index FROM nodes WHERE parent_id = ?',
  )
  const updateSortIndex = db.prepare('UPDATE nodes SET sort_index = ? WHERE id = ?')

  const parents = selectParents.all() as { parent_id: string }[]

  for (const { parent_id } of parents) {
    const children = selectChildren.all(parent_id) as MigrationChild[]

    // 已有 sort_index 的一个都不动，只填空的
    const toFill = children.filter((child) => child.sort_index === null)
    if (toFill.length === 0) continue

    // 基准值：全空 → 0；混合态 → 接在已有最大值之后。
    // 不能按「在全部子节点里按边顺序的位置」填 —— 那会与已有的显式值撞号，
    // 把用户「追加到末尾」的意图变成「插到中间」。
    // 用 reduce 而不是 Math.max(...spread)：兄弟极多时 spread 会爆调用栈。
    const assigned = children.filter((child): child is AssignedChild => child.sort_index !== null)
    const base = assigned.reduce((max, child) => Math.max(max, child.sort_index), -1) + 1

    // 父节点的边列表：边在 edges 表中的出现顺序（rowid 序）
    const edgePositions = new Map<string, number>()
    const parentEdges = selectParentEdges.all(parent_id) as { target: string; edge_type: string | null }[]
    parentEdges.forEach((edge, index) => {
      if (!edge.edge_type || !HIERARCHY_EDGE_TYPES.has(edge.edge_type)) return
      if (!edgePositions.has(edge.target)) edgePositions.set(edge.target, index)
    })

    const ordered = toFill
      .map((child) => {
        const edgePosition = edgePositions.get(child.id)
        return edgePosition === undefined
          ? { ...child, tier: 1, position: 0 }
          : { ...child, tier: 0, position: edgePosition }
      })
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          a.position - b.position ||
          compareCreatedAt(a.created_at, b.created_at) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )

    ordered.forEach((child, index) => updateSortIndex.run(base + index, child.id))
  }
}

/**
 * 第 3 步：default → hierarchical。
 * 判据是「target.parent_id === source」—— 父子关系唯一，不靠猜。
 * 语义关系边（business-flow / semantic / dependency …）保持原样。
 */
function rewriteHierarchyEdgeTypes(db: BetterSqlite3.Database): void {
  db.prepare(
    `UPDATE edges SET edge_type = 'hierarchical'
     WHERE edge_type = 'default'
       AND EXISTS (
         SELECT 1 FROM nodes t WHERE t.id = edges.target AND t.parent_id = edges.source
       )`,
  ).run()
}

/**
 * 第 4 步：补齐缺失的 hierarchical 边。
 * 手动新建的子节点只写了 parent_id、没建边，这一步把它们补上。
 * 边已经存在（迁移前改写来的，或本来就有）则不重复插入。
 *
 * 跨图护栏：父节点与子节点不在同一张图时**不补** —— 存量脏数据本身不是本任务能修的，
 * 但迁移补一条跨图层级边等于「制造」一条新的不一致（source 在别的图，
 * 边却以子节点所在图的 graph_id 落库）。
 */
function insertMissingHierarchyEdges(db: BetterSqlite3.Database): void {
  const selectParentedNodes = db.prepare(
    `SELECT c.id, c.parent_id, c.graph_id, p.graph_id AS parent_graph_id
     FROM nodes c JOIN nodes p ON p.id = c.parent_id
     WHERE c.parent_id IS NOT NULL`,
  )
  const selectExistingEdge = db.prepare(
    "SELECT 1 FROM edges WHERE source = ? AND target = ? AND edge_type = 'hierarchical' LIMIT 1",
  )
  const insertEdge = db.prepare(
    "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?, ?, ?, 'hierarchical', ?)",
  )

  const parentedNodes = selectParentedNodes.all() as {
    id: string
    parent_id: string
    graph_id: string
    parent_graph_id: string
  }[]

  for (const node of parentedNodes) {
    if (node.parent_graph_id !== node.graph_id) continue
    if (selectExistingEdge.get(node.parent_id, node.id)) continue
    insertEdge.run(generateId('edge'), node.parent_id, node.id, node.graph_id)
  }
}

/** created_at 兜底排序：缺失值排在最后 */
function compareCreatedAt(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return a < b ? -1 : 1
}
