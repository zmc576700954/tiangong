/**
 * 层级边派生
 *
 * 图谱的父子关系以 `nodes.parent_id` 为唯一事实来源，层级边由它派生而非从
 * `edges` 表读取。存储的历史层级边会在渲染时被丢弃，避免同一对父子节点
 * 出现两条线；迁移残留的 `default` 父子边同样被剔除。
 *
 * 这个文件同时住着「层级绘制约定」：边的方向（父 → 子，幽灵边 = 候选父 → 被拖节点）
 * 与绘制层级（普通节点 < 落点目标 < 被拖节点）。方向与层级是同一条约定，放一起一眼可查。
 */
import type { GraphNode, GraphEdge } from '@shared/types'

export interface DerivedHierarchyResult {
  /** 按 parent_id 派生的层级边；id 形如 `derived-<source>-<target>` */
  hierarchyEdges: GraphEdge[]
  /** 原样保留的语义边（已剔除存储的 hierarchical 边与重复的 default 层级边） */
  semanticEdges: GraphEdge[]
}

/** 幽灵连线（拖拽重挂预览）的前缀 —— 画布靠它把临时边与真边区分开 */
export const GHOST_EDGE_PREFIX = 'ghost-'

/** 落点目标抬到普通兄弟之上 —— 徽标溢出到节点框外，不会被后画的兄弟盖住 */
export const REPARENT_TARGET_Z_INDEX = 1001

/**
 * 被拖节点抬到落点目标之上 —— 用户正在拖的节点不能被它要放上去的节点埋掉。
 *
 * 2002 这个数不是随手写的：xyflow 的 `calculateZ` 会给**选中**的节点再 +1000
 * （`@xyflow/system/dist/esm/index.js:1771-1777`），
 * 所以落点目标的最终 z ∈ {1001 未选中, 2001 选中}，
 * 被拖节点的最终 z ∈ {2002, 3002} → **无论选中态如何，被拖节点都在落点目标之上**。
 */
export const REPARENT_DRAGGING_Z_INDEX = 2002

/**
 * 重挂拖拽期间的绘制层级：普通节点 < 落点目标 < 被拖节点。
 * 普通节点返回 undefined → 不设 zIndex，走 xyflow 的默认值 0。
 */
export function resolveReparentZIndex(
  isReparentTarget: boolean,
  isReparentDragging: boolean,
): number | undefined {
  if (isReparentDragging) return REPARENT_DRAGGING_Z_INDEX
  if (isReparentTarget) return REPARENT_TARGET_Z_INDEX
  return undefined
}

/**
 * 拖拽重挂的幽灵连线 —— **父 → 子**。
 *
 * 画布上所有层级边都是父 → 子（派生边见上，主进程存的那条 hierarchical 边也是），
 * 箭头（markerEnd）落在 target 那一端。幽灵连线必须跟它们同向：
 * 反过来画的话，拖拽时箭头指向「你将要认作父节点的那个节点」，
 * 松手后真正的边 B → A 出现，箭头当场跳到另一端 —— 预览与结果相反。
 *
 * @param draggedId 被拖动的节点（将成为子节点）
 * @param parentId  候选父节点（将成为父节点）
 */
export function buildReparentGhostEdge(
  draggedId: string,
  parentId: string,
  graphId: string,
): GraphEdge {
  return {
    // id 只用于前缀识别与缓存键，与方向无关 → 保持稳定
    id: `${GHOST_EDGE_PREFIX}${draggedId}-${parentId}`,
    source: parentId,
    target: draggedId,
    graphId,
    edgeType: 'hierarchical',
  }
}

export function deriveHierarchyEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
): DerivedHierarchyResult {
  const nodeIds = new Set(nodes.map(n => n.id))
  const hierarchyEdges: GraphEdge[] = []
  for (const node of nodes) {
    if (!node.parentId) continue
    if (!nodeIds.has(node.parentId)) continue   // 孤儿不产生边
    hierarchyEdges.push({
      id: `derived-${node.parentId}-${node.id}`,
      source: node.parentId,
      target: node.id,
      graphId: node.graphId,
      edgeType: 'hierarchical',
    })
  }
  const parentChildPairs = new Set(hierarchyEdges.map(e => `${e.source} ${e.target}`))
  const semanticEdges = edges.filter((e) => {
    // ⚠️ 下面这行是「画布层判定派生边」的前提：合并集里
    // edgeType === 'hierarchical' ⟺ 派生边。GraphCanvas 的 onEdgeClick 守卫
    // 与 flowEdges 的 `selectable` 都建立在这个等价上——若这里改成保留存储的
    // hierarchical 边，那两处守卫会把**存储边**也一起判成派生边。
    if (e.edgeType === 'hierarchical') return false                      // 存储的层级边不参与渲染
    if (e.edgeType === 'default' && parentChildPairs.has(`${e.source} ${e.target}`)) return false  // 迁移残留
    return true
  })
  return { hierarchyEdges, semanticEdges }
}
