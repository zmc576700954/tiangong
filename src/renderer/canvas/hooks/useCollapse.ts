/**
 * useCollapse —— 子树折叠/展开
 *
 * 折叠态的**唯一事实来源**是 `nodes.collapsed` 列（Task 11 落的库）。
 * 本 hook 只做两件事：
 * 1. 把 store 里的节点算成「画布上该出现哪些节点」（`visibleNodes`）；
 * 2. 提供折叠/展开的写入口（`toggle` → `graphStore.updateNode` → `node:update` → 落库）。
 *
 * 折叠节点**自己可见**，被它藏起来的是它的**整棵后代子树**（不只是直接子节点）。
 *
 * ⚠️ **引用稳定性**（本 hook 最容易踩的坑）：
 * `visibleNodes` 会进 `GraphCanvas` 的 `flowNodes` 依赖数组，而 `flowNodes`
 * 被 `useEffect(() => setRfNodes(flowNodes))` 写进 React state（`setRfNodes` 是
 * `useState` setter）。每帧新建一个数组 → state 更新 → 重渲染 → 又一个新数组 →
 * 无限重渲染（React 抛 *Maximum update depth exceeded*，画布白屏）。
 * 所以 `collapsedIds` / `visibleNodes` 一律 useMemo，依赖数组里只放引用稳定的值。
 *
 * ⚠️ **`toggle` 的稳定性靠「调用时读当前状态」，不靠 memo**：
 * 它在 `useCallback([])` 里用 `useGraphStore.getState()` 读该节点当下的 `collapsed`，
 * 而不是闭包里的 `collapsedIds`：
 * - 用闭包 → `collapsedIds` 一变 `toggle` 就换引用 → 注入 `flowNode.data` 的回调每帧换新；
 * - 用闭包 → 判断「当前是不是折叠的」会用旧值，方向算反。
 */
import { useCallback, useMemo } from 'react'
import type { GraphNode } from '@shared/types'
import { useGraphStore } from '../../store/graphStore'

export interface UseCollapseResult {
  /** 当前处于折叠态的节点 id */
  collapsedIds: Set<string>
  /** 该节点是否处于折叠态 */
  isCollapsed: (nodeId: string) => boolean
  /** 折叠/展开 —— 写入 store 并落库（`nodes.collapsed`） */
  toggle: (nodeId: string) => Promise<void>
  /** 折叠该节点时会被隐藏的后代数（**所有后代**，不含该节点本身） */
  hiddenDescendantCount: (nodeId: string) => number
  /** 画布上该出现的节点：折叠节点的整棵子树被隐藏，折叠节点自己可见 */
  visibleNodes: GraphNode[]
}

/** 层级索引：子 → 父、父 → 子 */
interface HierarchyIndex {
  parentById: Map<string, string>
  childrenByParent: Map<string, string[]>
}

/** 从节点列表建层级索引（O(n)） */
function buildHierarchy(nodes: GraphNode[]): HierarchyIndex {
  const parentById = new Map<string, string>()
  const childrenByParent = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.parentId) continue
    parentById.set(node.id, node.parentId)
    const siblings = childrenByParent.get(node.parentId)
    if (siblings) siblings.push(node.id)
    else childrenByParent.set(node.parentId, [node.id])
  }
  return { parentById, childrenByParent }
}

/**
 * 每个节点的后代数（**所有**后代，不含自身）。
 *
 * 后序遍历 + 显式栈：深链（几千层）不会爆调用栈。
 * `onPath` 防环：历史脏数据里 `parent_id` 成环时，环上那条边不参与遍历 ——
 * 否则遍历永远回不到头，画布直接卡死。
 */
function computeDescendantCounts(childrenByParent: Map<string, string[]>): Map<string, number> {
  const counts = new Map<string, number>()
  const settled = new Set<string>()

  for (const start of childrenByParent.keys()) {
    if (settled.has(start)) continue
    // 栈帧：[节点 id, 下一个待处理的孩子下标]
    const stack: Array<[string, number]> = [[start, 0]]
    const onPath = new Set<string>([start])
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const [nodeId, childIndex] = frame
      const children = childrenByParent.get(nodeId) ?? []
      if (childIndex < children.length) {
        frame[1] = childIndex + 1
        const child = children[childIndex]
        // 环上的边不参与遍历（否则出不了栈）
        if (settled.has(child) || onPath.has(child)) continue
        stack.push([child, 0])
        onPath.add(child)
        continue
      }
      // 孩子都结算完了 —— 后序汇总
      let total = 0
      for (const child of children) {
        total += 1 + (counts.get(child) ?? 0)
      }
      counts.set(nodeId, total)
      settled.add(nodeId)
      onPath.delete(nodeId)
      stack.pop()
    }
  }
  return counts
}

/**
 * 该节点是否被某个**严格祖先**的折叠态藏起来了。
 *
 * 折叠节点自己**不隐藏** —— 否则用户没法把它再展开。
 * `visited` 防环：历史脏数据里 `parent_id` 成环时，链断在这里即可（不再往上找）。
 */
function hasCollapsedAncestor(
  nodeId: string,
  parentById: Map<string, string>,
  collapsedIds: Set<string>,
): boolean {
  const visited = new Set<string>()
  let parentId = parentById.get(nodeId)
  while (parentId) {
    if (visited.has(parentId)) return false
    visited.add(parentId)
    if (collapsedIds.has(parentId)) return true
    parentId = parentById.get(parentId)
  }
  return false
}

export function useCollapse(): UseCollapseResult {
  // ⚠️ 必须用 selector 形式：getState() 不会让组件因节点变化而重渲染
  //    → 折叠状态改了但画布不更新
  const nodes = useGraphStore((s) => s.nodes)

  /** 处于折叠态的节点 id */
  const collapsedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const node of nodes) {
      if (node.collapsed) ids.add(node.id)
    }
    return ids
  }, [nodes])

  /** 层级索引 —— 跟 nodes 同生共死，引用稳定 */
  const hierarchy = useMemo(() => buildHierarchy(nodes), [nodes])

  /** 每个节点的后代数 —— 只算一次，供 O(1) 查询 */
  const descendantCounts = useMemo(
    () => computeDescendantCounts(hierarchy.childrenByParent),
    [hierarchy],
  )

  /**
   * 画布上该出现的节点。
   *
   * `hierarchy` 跟 `nodes` 同步变化，多写进依赖数组不改变重算时机，
   * 但 exhaustive-deps 要求把 memo 里用到的每个值都列出来。
   */
  const visibleNodes = useMemo(
    () => nodes.filter((node) => !hasCollapsedAncestor(node.id, hierarchy.parentById, collapsedIds)),
    [nodes, hierarchy, collapsedIds],
  )

  const isCollapsed = useCallback((nodeId: string) => collapsedIds.has(nodeId), [collapsedIds])

  const hiddenDescendantCount = useCallback(
    (nodeId: string) => descendantCounts.get(nodeId) ?? 0,
    [descendantCounts],
  )

  /**
   * 折叠/展开 —— **引用稳定**（依赖数组为空）。
   *
   * 读的是 store 的**当前**状态（`getState()`），不是闭包里的 `collapsedIds` ——
   * 见文件头注释：既保引用稳定，又保证折叠方向算得对。
   */
  const toggle = useCallback(async (nodeId: string) => {
    const current = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
    const nextCollapsed = !(current?.collapsed ?? false)
    try {
      await useGraphStore.getState().updateNode(nodeId, { collapsed: nextCollapsed })
    } catch (err) {
      // 调用方（BizNode 的折叠按钮）不 await 也不 catch —— 抛出去会变成
      // unhandled rejection。失败只记日志：写不回库的折叠态会在下次读库时
      // 自己纠正过来。
      console.error('[useCollapse] toggle failed:', err)
    }
  }, [])

  return { collapsedIds, isCollapsed, toggle, hiddenDescendantCount, visibleNodes }
}
