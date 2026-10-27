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
 * 迁移前层级边是 'default'，迁移后是 'hierarchical' —— 两者都要认，
 * 否则第二次运行时排序会退回 created_at 兜底，破坏幂等。
 */
const HIERARCHY_EDGE_TYPES = new Set(['default', 'hierarchical'])

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
 */
function clearOrphanParentIds(db: BetterSqlite3.Database): void {
  db.prepare(
    `UPDATE nodes SET parent_id = NULL
     WHERE parent_id IS NOT NULL
       AND parent_id NOT IN (SELECT id FROM nodes)`,
  ).run()
}

/**
 * 第 2 步：回填 sort_index（兄弟顺序）。
 *
 * 对每个父节点，把它的**全部**孩子排出一个确定的次序：
 * - 有 default/hierarchical 边的孩子 → 取该边在「父节点边列表」中的位置
 * - 没有任何边的孩子 → 落到 created_at 兜底，排在有边的那批之后
 * 然后从 0 开始连续赋值。
 *
 * 无 parent_id 的节点是根节点，sort_index 保持 NULL（根节点没有兄弟可言）。
 *
 * ⚠️ 迁移每次启动都会重跑（runIncrementalMigrations 在快/慢两条路径上都调用它），
 * 所以这里的排序号是「按边顺序重新推导」，不是「只填空位」。
 * 后续任务若让 sort_index 变成用户可改（兄弟重排 / reparent 重排），
 * 必须同步维护 hierarchical 边的顺序，或把本步改成只补 NULL ——
 * 否则用户排好的兄弟顺序会在下次启动时被边顺序覆盖。
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
    'SELECT id, created_at FROM nodes WHERE parent_id = ?',
  )
  const updateSortIndex = db.prepare('UPDATE nodes SET sort_index = ? WHERE id = ?')

  const parents = selectParents.all() as { parent_id: string }[]

  for (const { parent_id } of parents) {
    // 父节点的边列表：边在 edges 表中的出现顺序（rowid 序）
    const edgePositions = new Map<string, number>()
    const parentEdges = selectParentEdges.all(parent_id) as { target: string; edge_type: string | null }[]
    parentEdges.forEach((edge, index) => {
      if (!edge.edge_type || !HIERARCHY_EDGE_TYPES.has(edge.edge_type)) return
      if (!edgePositions.has(edge.target)) edgePositions.set(edge.target, index)
    })

    const children = selectChildren.all(parent_id) as { id: string; created_at: string | null }[]

    const ordered = children
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

    ordered.forEach((child, index) => updateSortIndex.run(index, child.id))
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
 */
function insertMissingHierarchyEdges(db: BetterSqlite3.Database): void {
  const selectParentedNodes = db.prepare(
    'SELECT id, parent_id, graph_id FROM nodes WHERE parent_id IS NOT NULL',
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
  }[]

  for (const node of parentedNodes) {
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
