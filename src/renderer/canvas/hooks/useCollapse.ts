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

/**
 * 层级索引 —— 一片**无环**的森林。
 *
 * `childrenByParent` 里不可能出现环（`buildHierarchy` 在源头就把环断了），
 * 所以「向下数后代」和「向上找折叠祖先」读的是同一棵结构，两个口径必然一致。
 */
interface HierarchyIndex {
  /** 父 → 子（环上的父边已断开） */
  childrenByParent: Map<string, string[]>
  /** 森林的根 —— 没有父的节点 */
  roots: string[]
}

/** 折叠模型：隐藏集合 + 后代计数 —— 这两个数字必须对得上 */
interface CollapseModel {
  /** 被折叠的祖先藏起来的节点（折叠节点自己不在里面） */
  hiddenIds: Set<string>
  /** 每个节点的后代数（所有后代，不含自身） */
  descendantCounts: Map<string, number>
}

/**
 * 找出父指针图里所有环上的节点。
 *
 * ⚠️ 与 `layouts/tree-layout.ts` 的 `findBackEdgeIds` 是**同一套三色 DFS**
 * （那边是 parent → child 的边，这边是 child → parent 的父链），
 * 两点不同，都是必须的：
 *
 * 1. **迭代**，不递归 —— 那边是 `function dfs(u)`，1 万层的脏链会爆栈。
 * 2. **断掉整个环的父链接**，而不是只断「回边」那一条 ——
 *    只断一条的话，断哪条取决于 DFS 从哪个节点起步（环上任意节点开始，
 *    断掉的边集合不一样）。而父指针图里每个节点**至多一个父** →
 *    每个连通分量要么是一棵树，要么**恰好含一个环**（函数图的性质），
 *    环上的节点全部解除父链接之后，它们各自成为根，**不在环上**的孩子
 *    仍然挂在原位 —— 这跟迭代顺序无关。
 *
 * 每个节点只会被走一遍 → O(n)。纯迭代，没有递归 → 深链不会爆栈。
 */
function findCycleNodes(parentById: Map<string, string>): Set<string> {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const cycleNodes = new Set<string>()

  for (const start of parentById.keys()) {
    if ((color.get(start) ?? WHITE) === BLACK) continue
    // 顺着父指针往上走的路径
    const path: string[] = []
    let current: string | undefined = start
    while (current !== undefined && (color.get(current) ?? WHITE) === WHITE) {
      color.set(current, GRAY)
      path.push(current)
      current = parentById.get(current)
    }
    // current 已经是 GRAY → 它就在当前路径上 → 路径上从 current 开始的那一段成环
    if (current !== undefined && color.get(current) === GRAY) {
      for (const id of path.slice(path.indexOf(current))) cycleNodes.add(id)
    }
    for (const id of path) color.set(id, BLACK)
  }
  return cycleNodes
}

/**
 * 建层级索引 —— 建成一片**无环**的森林。
 *
 * 父子关系的事实来源是 `nodes.parent_id`。父节点不存在（脏数据）= 根节点。
 *
 * ⚠️ **为什么要在源头断环**：折叠节点自己必须永远可见（否则用户点完折叠就把
 * 按钮点没了，而折叠态是**落库**的 —— 重开应用再也展不开）；徽标上的数字必须
 * 等于实际被藏起来的节点数。这两条都要求「向上找折叠祖先」与「向下数后代」
 * 读**同一棵无环结构** —— 两个口径才必然一致。
 * 防环守卫只保证不死循环，不保证数字对。
 *
 * 断掉环上**所有**节点的父边（而不是只断一条）是为了跟迭代顺序无关：
 * 从环上任意一个节点开始走，断掉的边集合都一样。环里的节点各自成为根，
 * 它们那些**不在环上**的孩子仍然挂在原位。
 */
function buildHierarchy(nodes: GraphNode[]): HierarchyIndex {
  const ids = new Set(nodes.map((n) => n.id))
  /** 原始父指针 —— 只记真实存在的父（父节点不存在 = 根） */
  const rawParent = new Map<string, string>()
  for (const node of nodes) {
    if (node.parentId && ids.has(node.parentId)) rawParent.set(node.id, node.parentId)
  }

  const cycleNodes = findCycleNodes(rawParent)

  const childrenByParent = new Map<string, string[]>()
  const roots: string[] = []
  for (const node of nodes) {
    const parentId = cycleNodes.has(node.id) ? undefined : rawParent.get(node.id)
    if (parentId === undefined) {
      roots.push(node.id)
      continue
    }
    const siblings = childrenByParent.get(parentId)
    if (siblings) siblings.push(node.id)
    else childrenByParent.set(parentId, [node.id])
  }
  return { childrenByParent, roots }
}

/**
 * 一趟解析出「隐藏集合」与「后代计数」。
 *
 * ⚠️ **不能**给每个节点各走一遍完整的祖先链 —— 那是 O(n × 深度)，一条 1 万层的
 * 脏链就是 10⁸ 次操作，浏览器直接卡死。祖先链在这里**一趟**解析完：从森林的
 * 根往下推，每个节点带着「有没有折叠的严格祖先」这个标记走一趟。
 *
 * 隐藏判定：孩子被藏起来 ⟺ 父节点自己折叠，或父节点已经被折叠的祖先藏起来了。
 * 折叠节点自己**不隐藏**（它是那个折叠按钮所在的地方）。
 */
function computeCollapseModel(
  hierarchy: HierarchyIndex,
  collapsedIds: Set<string>,
): CollapseModel {
  const { childrenByParent, roots } = hierarchy
  const hiddenIds = new Set<string>()
  const descendantCounts = new Map<string, number>()
  /** 访问顺序（父在子之前）—— 反过来就是后序，用来累加后代数 */
  const order: string[] = []
  /** 安全网：万一层级索引里还有环（不该发生），也不至于死循环 */
  const visited = new Set<string>()
  /** 栈帧：[节点 id, 是否有折叠的严格祖先] */
  const stack: Array<[string, boolean]> = roots.map((id) => [id, false])

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    stack.pop()
    const [nodeId, ancestorCollapsed] = frame
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    order.push(nodeId)
    const childHidden = ancestorCollapsed || collapsedIds.has(nodeId)
    for (const child of childrenByParent.get(nodeId) ?? []) {
      if (childHidden) hiddenIds.add(child)
      stack.push([child, childHidden])
    }
  }

  // 反序累加：order 是前序遍历的结果，倒过来孩子一定排在父节点前面
  for (let i = order.length - 1; i >= 0; i--) {
    const nodeId = order[i]
    let total = 0
    for (const child of childrenByParent.get(nodeId) ?? []) {
      total += 1 + (descendantCounts.get(child) ?? 0)
    }
    descendantCounts.set(nodeId, total)
  }

  return { hiddenIds, descendantCounts }
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

  /** 层级索引 —— 跟 nodes 同生共死，引用稳定；建成无环的森林 */
  const hierarchy = useMemo(() => buildHierarchy(nodes), [nodes])

  /** 隐藏集合 + 后代计数 —— 两者读同一棵森林，口径必然一致 */
  const model = useMemo(() => computeCollapseModel(hierarchy, collapsedIds), [hierarchy, collapsedIds])

  /**
   * 画布上该出现的节点。
   *
   * `hierarchy` / `model` 跟 `nodes` 同步变化，多写进依赖数组不改变重算时机，
   * 但 exhaustive-deps 要求把 memo 里用到的每个值都列出来。
   */
  const visibleNodes = useMemo(
    () => nodes.filter((node) => !model.hiddenIds.has(node.id)),
    [nodes, model],
  )

  const isCollapsed = useCallback((nodeId: string) => collapsedIds.has(nodeId), [collapsedIds])

  const hiddenDescendantCount = useCallback(
    (nodeId: string) => model.descendantCounts.get(nodeId) ?? 0,
    [model],
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
