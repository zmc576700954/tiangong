/**
 * Hierarchy Service —— 父子关系变更的唯一入口
 *
 * 事实来源：`nodes.parent_id`（spec §4.4）。`edges` 表里的 `hierarchical` 边
 * 只是 parent_id 的**存储层镜像**（渲染层用 deriveHierarchyEdges 从 parent_id
 * 派生层级边，存储边不参与渲染），但它必须与 parent_id 保持一致 ——
 * 存量数据、迁移补边都依赖它。
 *
 * 一次 reparent 在**一个事务**里改写三处：
 *   1. `nodes.parent_id`     —— 事实来源
 *   2. `nodes.sort_index`    —— 兄弟顺序（spec §4.8）
 *   3. `edges` 的 hierarchical 边 —— 存储层镜像
 * 外加把整棵子树平移到新父节点的下方，并把新坐标返回给渲染层做动画。
 *
 * 校验顺序（有意为之）：自环 → 跨图 → 防环 → 类型。
 * 自环与跨图是「结构性」错误，先于类型判定报告；防环又先于类型，
 * 因为「挂到自己的后代下面」在用户操作里比「类型不匹配」更常见，
 * 且两者同时成立时前者才是真正的原因。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { ReparentResult } from '@shared/types/graph'
import { ErrorCode, HierarchyError, IpcError } from '../errors'
import { generateId } from '../shared/env'
import { isDescendant } from '../shared/hierarchy-utils'
import { nodeTypeRegistry } from '../shared/node-type-registry'

/** service 需要的节点投影 —— 只读这几列 */
interface NodeRow {
  id: string
  type: string
  graph_id: string
  parent_id: string | null
  position_x: number
  position_y: number
}

/** 坐标投影（子树平移用） */
interface PositionRow {
  id: string
  x: number
  y: number
}

/**
 * 平移后子树与兄弟之间的垂直间距（画布单位）。
 *
 * 节点高度 60~90px（tree-layout.ts 的 NODE_SIZES）、兄弟间距 nodesep=120 ——
 * 取 160 留出一个节点高度加呼吸位，保证子树不会压在兄弟身上。
 */
const SUBTREE_VERTICAL_GAP = 160

/** 求一组坐标的上下界 —— 用 reduce 而不是 Math.min(...spread)：子树大时 spread 会爆调用栈 */
function bounds(values: number[]): { min: number; max: number } {
  return values.reduce(
    (acc, v) => ({ min: Math.min(acc.min, v), max: Math.max(acc.max, v) }),
    { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY },
  )
}

export class HierarchyService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  /**
   * 把 nodeId 挂到 newParentId 下。
   *
   * @throws {IpcError} nodeId 或 newParentId 不存在
   * @throws {HierarchyError} 自环 / 跨图 / 成环 / 父子类型不合法
   */
  reparent(nodeId: string, newParentId: string): ReparentResult {
    const node = this.getNode(nodeId)
    if (!node) {
      throw new IpcError(`Node not found: ${nodeId}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const newParent = this.getNode(newParentId)
    if (!newParent) {
      throw new IpcError(`Node not found: ${newParentId}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }

    // ① 自环
    if (nodeId === newParentId) {
      throw new HierarchyError(
        `Node ${nodeId} cannot be its own parent`,
        ErrorCode.HIERARCHY_SELF_PARENT,
        { nodeId },
      )
    }

    // ② 跨图 —— 比 graph_id 而不是 graph_type：
    //    同一张图里可以同时有 graph_type='online' 与 'dev' 的节点（spec §4.4.1）
    if (node.graph_id !== newParent.graph_id) {
      throw new HierarchyError(
        `Cannot move node ${nodeId} across graphs (${node.graph_id} → ${newParent.graph_id})`,
        ErrorCode.HIERARCHY_CROSS_GRAPH,
        { nodeId, newParentId, nodeGraphId: node.graph_id, parentGraphId: newParent.graph_id },
      )
    }

    // ③ 防环 —— 新父不能落在被移动节点自己的子树里。
    //    isDescendant(祖先, 后代)：祖先在前，后代在后。
    if (isDescendant(nodeId, newParentId, (id) => this.getParentId(id))) {
      throw new HierarchyError(
        `Cannot move node ${nodeId} under its own descendant ${newParentId}`,
        ErrorCode.HIERARCHY_CYCLE,
        { nodeId, newParentId },
      )
    }

    // ④ 父子类型 —— 主进程 nodeTypeRegistry 是唯一权威（双向校验）
    if (!nodeTypeRegistry.validateParentChild(newParent.type, node.type)) {
      throw new HierarchyError(
        `Cannot move ${node.type} under ${newParent.type}`,
        ErrorCode.HIERARCHY_TYPE_INVALID,
        { nodeId, newParentId, parentType: newParent.type, childType: node.type },
      )
    }

    const oldParentId = node.parent_id

    const run = this.db.transaction((): ReparentResult => {
      // 子树要在改 parent_id **之前**收集 —— 此刻 nodeId 还挂在旧父下面
      const descendants = this.collectDescendants(nodeId)

      // 目标父节点的其他子节点 = 平移的避让基准
      const movedIds = new Set<string>([nodeId, ...descendants.map((d) => d.id)])
      const siblings = this.getChildren(newParentId).filter((c) => !movedIds.has(c.id))

      // 新兄弟序号：目标父节点现有子节点的最大 sort_index + 1
      const newSortIndex = this.nextSortIndex(newParentId, nodeId)

      // ① 改写事实来源
      const now = new Date().toISOString()
      this.db
        .prepare('UPDATE nodes SET parent_id = ?, sort_index = ?, updated_at = ? WHERE id = ?')
        .run(newParentId, newSortIndex, now, nodeId)

      // ② 同步层级边镜像
      this.syncHierarchyEdge(oldParentId, newParentId, nodeId, node.graph_id)

      // ③ 旧父节点的其余子节点重排为连续号（空出来的位置不留洞）
      if (oldParentId && oldParentId !== newParentId) {
        this.renumberSiblings(oldParentId)
      }

      // ④ 子树整体平移
      const movedPositions = this.translateSubtree(node, descendants, siblings)
      const updatePosition = this.db.prepare(
        'UPDATE nodes SET position_x = ?, position_y = ?, updated_at = ? WHERE id = ?'
      )
      for (const p of movedPositions) {
        updatePosition.run(p.x, p.y, now, p.id)
      }

      return { nodeId, oldParentId, newParentId, movedPositions }
    })

    return run()
  }

  private getNode(id: string): NodeRow | undefined {
    return this.db
      .prepare('SELECT id, type, graph_id, parent_id, position_x, position_y FROM nodes WHERE id = ?')
      .get(id) as NodeRow | undefined
  }

  private getParentId(id: string): string | null {
    const row = this.db.prepare('SELECT parent_id FROM nodes WHERE id = ?').get(id) as
      | { parent_id: string | null }
      | undefined
    return row?.parent_id ?? null
  }

  private getChildren(parentId: string): PositionRow[] {
    return this.db
      .prepare('SELECT id, position_x AS x, position_y AS y FROM nodes WHERE parent_id = ?')
      .all(parentId) as PositionRow[]
  }

  /**
   * 目标父节点下的下一个兄弟序号。
   *
   * COALESCE 不能省：兄弟全是 NULL 时 MAX 返回 NULL，而 NULL + 1 在 SQLite 里
   * 仍是 NULL —— 被移动的节点会落进布局「undefined 排最后」的兜底里，位置不确定。
   * excludeId 把被移动节点自己排除掉，避免它把自己的旧序号算进去。
   */
  private nextSortIndex(parentId: string, excludeId: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(sort_index), -1) + 1 AS next FROM nodes WHERE parent_id = ? AND id <> ?',
      )
      .get(parentId, excludeId) as { next: number }
    return row.next
  }

  /**
   * 收集 nodeId 的全部后代（不含自身），按广度优先（深度递增）返回。
   *
   * visited 集合防死循环：存量孤儿数据可能让 parent_id 成环，
   * 顺着它一路走下去会永远停不下来。
   */
  private collectDescendants(nodeId: string): PositionRow[] {
    const selectChildren = this.db.prepare(
      'SELECT id, position_x AS x, position_y AS y FROM nodes WHERE parent_id = ?',
    )
    const result: PositionRow[] = []
    const visited = new Set<string>([nodeId])
    let frontier = [nodeId]
    while (frontier.length > 0) {
      const nextFrontier: string[] = []
      for (const parentId of frontier) {
        const children = selectChildren.all(parentId) as PositionRow[]
        for (const child of children) {
          if (visited.has(child.id)) continue
          visited.add(child.id)
          result.push(child)
          nextFrontier.push(child.id)
        }
      }
      frontier = nextFrontier
    }
    return result
  }

  /**
   * 同步 parent_id 的存储层镜像（edges 里的层级边）。
   *
   * 认两种形态的层级边：`'hierarchical'`（当前形态）与 `'default'`（迁移前的形态）。
   * hierarchy-migration.ts 明确写了「库里可能同时存在两种形态的层级边」——
   * 扫描器建出来的层级边至今仍是 `'default'`（project-analyzer.ts:74/105/132，
   * Task 8 才改成 `'hierarchical'`）。只认 `'hierarchical'` 会让旧父那条边变成孤儿：
   * 父子关系已改，迁移不会再把它改写成层级边，渲染层会把它**当语义边画出来**
   * ——拖走一个节点，旧父与它之间留下一条莫名其妙的连线。
   *
   * 收敛到「同一对父子恰好一条层级边」：
   * - 目标父已有层级边 → 删掉旧父的那条，保留目标父的（并统一成 `'hierarchical'`）
   * - 只有旧父的层级边 → 改它的 source（保住边 id 与 rowid）复用
   * - 两边都没有 → 插入新边
   */
  private syncHierarchyEdge(
    oldParentId: string | null,
    newParentId: string,
    nodeId: string,
    graphId: string,
  ): void {
    const selectEdges = this.db.prepare(
      "SELECT id FROM edges WHERE source = ? AND target = ? AND edge_type IN ('default', 'hierarchical') ORDER BY rowid",
    )
    const deleteEdge = this.db.prepare('DELETE FROM edges WHERE id = ?')

    // 旧父的层级边：第一条可以改 source 复用，其余删掉
    const oldEdges =
      oldParentId && oldParentId !== newParentId
        ? (selectEdges.all(oldParentId, nodeId) as { id: string }[])
        : []
    for (const extra of oldEdges.slice(1)) deleteEdge.run(extra.id)

    // 目标父的层级边：已存在就复用，多余的删掉
    const newEdges = selectEdges.all(newParentId, nodeId) as { id: string }[]
    for (const extra of newEdges.slice(1)) deleteEdge.run(extra.id)
    const keep = newEdges[0]

    if (keep) {
      // 目标父已有层级边 —— 旧父那条成了多余的
      if (oldEdges[0]) deleteEdge.run(oldEdges[0].id)
      // 统一成 'hierarchical'（历史遗留可能是 'default'）
      this.db.prepare("UPDATE edges SET edge_type = 'hierarchical' WHERE id = ?").run(keep)
      return
    }
    if (oldEdges[0]) {
      this.db
        .prepare("UPDATE edges SET source = ?, edge_type = 'hierarchical' WHERE id = ?")
        .run(newParentId, oldEdges[0].id)
      return
    }
    this.db
      .prepare(
        "INSERT INTO edges (id, source, target, edge_type, graph_id) VALUES (?, ?, ?, 'hierarchical', ?)",
      )
      .run(generateId('edge'), newParentId, nodeId, graphId)
  }

  /** 把某个父节点的子节点 sort_index 重排为 0,1,2,…（保持既有相对顺序，NULL 的排在最后） */
  private renumberSiblings(parentId: string): void {
    const children = this.db
      .prepare(
        'SELECT id FROM nodes WHERE parent_id = ? ORDER BY (sort_index IS NULL), sort_index ASC, id ASC',
      )
      .all(parentId) as { id: string }[]
    const update = this.db.prepare('UPDATE nodes SET sort_index = ? WHERE id = ?')
    children.forEach((child, index) => update.run(index, child.id))
  }

  /**
   * 子树平移：整棵子树**刚性平移**，内部相对位置完全不变。
   *
   * 落点：以目标父节点「其他子节点」的包围盒为基准，把子树放到该包围盒**下方**：
   *   - 子树的左边缘对齐包围盒左边缘
   *   - 子树的**顶边**落在包围盒下沿 + SUBTREE_VERTICAL_GAP
   *
   * 用顶边（而不是底边）对齐：子树的整个 y 区间因此严格大于所有兄弟的 y，
   * 无论子树多高都不会与兄弟重叠。对齐底边则相反 —— 子树可能向上伸出，
   * 把兄弟包进自己的 y 区间里。
   *
   * 目标父节点没有别的子节点时无处可避，原地不动。
   */
  private translateSubtree(
    root: NodeRow,
    descendants: PositionRow[],
    siblings: PositionRow[],
  ): PositionRow[] {
    // 相对位移：后代相对子树根的偏移（子树内部的相对位置就此固定下来）
    const relative = descendants.map((d) => ({
      id: d.id,
      dx: d.x - root.position_x,
      dy: d.y - root.position_y,
    }))

    // 子树相对根的左上角偏移 —— 落点只需要这两个值
    const relMinX = Math.min(0, bounds(relative.map((r) => r.dx)).min)
    const relMinY = Math.min(0, bounds(relative.map((r) => r.dy)).min)

    let anchorX = root.position_x
    let anchorY = root.position_y
    if (siblings.length > 0) {
      const siblingBox = {
        minX: bounds(siblings.map((s) => s.x)).min,
        maxY: bounds(siblings.map((s) => s.y)).max,
      }
      anchorX = siblingBox.minX - relMinX
      anchorY = siblingBox.maxY - relMinY + SUBTREE_VERTICAL_GAP
    }

    return [
      { id: root.id, x: anchorX, y: anchorY },
      ...relative.map((r) => ({ id: r.id, x: anchorX + r.dx, y: anchorY + r.dy })),
    ]
  }
}
