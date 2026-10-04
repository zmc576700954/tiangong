/**
 * Recipe DAG Builder (D5c-1)
 *
 * 把 RecipeDefinition.steps 转换成静态 DAG（节点 + 边 + 拓扑层级）。
 *
 * 边来源：
 *   1. depends_on 显式声明（最高优先级）
 *   2. ${outputs.<stepId>.<field>} 模板引用（隐式推断）
 *   3. 数组顺序兜底：相邻步骤的前向边（仅当入度为 0 的孤立节点需要补链路）
 *
 * 拓扑层级算法（Kahn）：
 *   - level 0 = 入度 0 的节点
 *   - level n = 所有 (level n-1) 节点指向的节点，去掉已分配层级的
 *   - 同一层级的节点视为可并行
 *
 * 循环检测：基于 Kahn 算法 —— Kahn 完成后未访问节点 = 至少一个环。
 * 多环时不做精确拆分，cycles 字段返回所有未访问节点（UI 用红框 + warning）。
 *
 * 边界（与 CLAUDE.md "Boundaries with Agent CLI" 一致）：
 *   - 本模块纯函数，不读文件系统 / DB；可单元测试。
 *   - 不修改 RecipeDefinition，不抛跨边界错误；缺依赖以 missingDeps 形式回传。
 */

import type {
  RecipeDefinition,
  RecipeDag,
  RecipeDagEdge,
  RecipeDagNode,
  RecipeStep,
} from '@shared/types/recipe'

/** 把 step 派生为稳定 id。规则与 RecipeRunner 保持一致：id → name → 索引。 */
export function resolveStepId(step: RecipeStep, index: number): string {
  return step.id ?? step.name ?? `step_${index}`
}

/** 把 step 派生为显示名。规则与 RecipeRunner 保持一致：name → id → "Step N"。 */
export function resolveStepLabel(step: RecipeStep, index: number): string {
  return step.name ?? step.id ?? `Step ${index + 1}`
}

/**
 * 从 agent step 的 prompt 中提取 ${outputs.<stepId>.<field>} 引用。
 *
 * 匹配规则：
 *   - ${outputs.X.Y}  — 单花括号（含可选空白）
 *   - {{ outputs.X.Y }} — 双花括号 Mustache 风格
 *
 * 返回被引用的上游 stepId 集合（重复 + 重名都去重）。
 *
 * 故意宽松：解析失败也只跳过，不抛错（缺失依赖由 missingDeps 兜底）。
 */
export function extractOutputRefs(prompt: string): string[] {
  const ids = new Set<string>()
  // 匹配 ${...} 与 {{...}}，捕获第一段点号分隔的 id
  // 1) ${ outputs.X.Y } 或 ${outputs.X.Y}（单花括号 + 可选空白）
  const re1 = /\$\{\s*outputs\.([a-zA-Z0-9_-]+)/g
  // 2) {{ outputs.X.Y }}（双花括号 Mustache）
  const re2 = /\{\{\s*outputs\.([a-zA-Z0-9_-]+)/g
  for (const re of [re1, re2]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(prompt)) !== null) {
      ids.add(m[1]!)
    }
  }
  return [...ids]
}

/**
 * 构建 Recipe 的 DAG 视图。
 *
 * @param def - RecipeDefinition（仅读）
 * @returns RecipeDag - 含节点 / 边 / 拓扑层级 / 循环检测结果
 */
export function buildRecipeDag(def: RecipeDefinition): RecipeDag {
  const steps = def.steps
  const total = steps.length

  // 1. 派生稳定 id 与显示名
  const ids = steps.map((s, i) => resolveStepId(s, i))
  const labels = steps.map((s, i) => resolveStepLabel(s, i))
  const idToIndex = new Map<string, number>()
  ids.forEach((id, i) => idToIndex.set(id, i))

  // 2. 构造节点
  const nodes: RecipeDagNode[] = steps.map((s, i) => {
    const node: RecipeDagNode = {
      id: ids[i]!,
      index: i,
      label: labels[i]!,
      nodeType: s.kind,
      status: 'pending',
      level: 0,
    }
    if (s.kind === 'agent') {
      node.agentType = s.agent_type
    } else {
      node.shellCommand = s.command[0]
    }
    return node
  })

  // 3. 构造边
  const edges: RecipeDagEdge[] = []
  const seen = new Set<string>()
  const missingDeps: RecipeDag['missingDeps'] = []
  let edgeSeq = 0
  const addEdge = (source: string, target: string, kind: RecipeDagEdge['kind']): void => {
    if (source === target) return // 自环跳过
    const key = `${source}->${target}:${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ id: `e${edgeSeq++}`, source, target, kind })
  }

  for (let i = 0; i < total; i++) {
    const step = steps[i]!
    const targetId = ids[i]!

    // 3a. depends_on 显式声明
    if (step.depends_on && step.depends_on.length > 0) {
      for (const dep of step.depends_on) {
        if (idToIndex.has(dep)) {
          addEdge(dep, targetId, 'depends_on')
        } else {
          missingDeps.push({ from: targetId, to: targetId, reason: 'depends_on', missing: dep })
        }
      }
    }

    // 3b. prompt 里的 ${outputs.X.Y} 引用（仅 agent 步骤）
    if (step.kind === 'agent') {
      const refs = extractOutputRefs(step.prompt)
      for (const refId of refs) {
        if (idToIndex.has(refId)) {
          addEdge(refId, targetId, 'output-ref')
        } else {
          missingDeps.push({ from: targetId, to: targetId, reason: 'output-ref', missing: refId })
        }
      }
    }
  }

  // 3c. 数组顺序兜底：孤立节点补前向边
  // 如果一个节点没有入边（孤立），给它补一条到前一个节点的前向边；
  // 这保证了：没有显式依赖的 Recipe 仍按数组顺序串成链。
  // 检测"孤立"：没有入边的节点 + 不是第一个节点。
  const incomingCount = new Map<string, number>()
  for (const id of ids) incomingCount.set(id, 0)
  for (const e of edges) {
    incomingCount.set(e.target, (incomingCount.get(e.target) ?? 0) + 1)
  }
  for (let i = 1; i < total; i++) {
    const curId = ids[i]!
    if ((incomingCount.get(curId) ?? 0) === 0) {
      const prevId = ids[i - 1]!
      addEdge(prevId, curId, 'index')
    }
  }

  // 4. 拓扑层级（Kahn）
  const levelOf = new Map<string, number>()
  const remaining = new Map<string, number>()
  for (const id of ids) remaining.set(id, 0)
  for (const e of edges) {
    remaining.set(e.target, (remaining.get(e.target) ?? 0) + 1)
  }

  // level 0：入度为 0 的节点
  let frontier = ids.filter((id) => (remaining.get(id) ?? 0) === 0)
  let level = 0
  const visited = new Set<string>()
  while (frontier.length > 0) {
    for (const id of frontier) {
      levelOf.set(id, level)
      visited.add(id)
    }
    const next: string[] = []
    const nextSet = new Set<string>()
    for (const id of frontier) {
      for (const e of edges) {
        if (e.source !== id) continue
        const t = e.target
        const left = (remaining.get(t) ?? 0) - 1
        remaining.set(t, left)
        if (left === 0 && !visited.has(t) && !nextSet.has(t)) {
          next.push(t)
          nextSet.add(t)
        }
      }
    }
    frontier = next
    level++
  }

  // 5. 检测环：未访问节点即为环内成员
  const cycles: string[][] = []
  const unvisited = ids.filter((id) => !visited.has(id))
  if (unvisited.length > 0) {
    // 简化版：把所有未访问节点当作一个环（不做精确拆分，UI 仅显示红色警告）。
    // 若要做精确拆分，需要对未访问子图再做 DFS。
    cycles.push(unvisited)
  }

  // 6. 写回节点 level
  for (const node of nodes) {
    node.level = levelOf.get(node.id) ?? 0
  }

  // 7. 构造 levels 数组（按 level 分组）
  const levelMap = new Map<number, RecipeDagNode[]>()
  for (const node of nodes) {
    const arr = levelMap.get(node.level) ?? []
    arr.push(node)
    levelMap.set(node.level, arr)
  }
  // 节点在同一 level 内按原始 index 排序
  for (const arr of levelMap.values()) {
    arr.sort((a, b) => a.index - b.index)
  }
  const levels: RecipeDagNode[][] = []
  for (let lv = 0; lv < levelMap.size; lv++) {
    levels.push(levelMap.get(lv) ?? [])
  }

  return {
    recipeId: def.id,
    nodes,
    edges,
    levels,
    cycles,
    missingDeps,
  }
}

/**
 * 把 DAG 节点映射成 @xyflow/react 兼容的 React Flow Node 列表。
 *
 * 布局策略：列 = level，行 = 同 level 内的索引。
 * 这样保证：
 *   - 依赖关系从左到右
 *   - 同一列（level）的节点视为可并行
 *   - 节点不会重叠
 *
 * 不引入 dagre 等第三方布局 —— Recipe 通常 ≤ 20 步，朴素网格够用。
 */
export function dagToFlowNodes(dag: RecipeDag, options?: { xGap?: number; yGap?: number }): {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}[] {
  const xGap = options?.xGap ?? 220
  const yGap = options?.yGap ?? 90
  return dag.levels.flatMap((levelNodes, lv) =>
    levelNodes.map((n, rowIdx) => ({
      id: n.id,
      // 不指定 type → React Flow 用默认矩形节点（更可控的样式）
      position: { x: lv * xGap, y: rowIdx * yGap },
      data: {
        label: n.label,
        nodeType: n.nodeType,
        agentType: n.agentType,
        shellCommand: n.shellCommand,
        status: n.status,
        index: n.index,
        error: n.error,
      },
    })),
  )
}

/** 把 DAG 边映射成 @xyflow/react 兼容的 Edge 列表。 */
export function dagToFlowEdges(dag: RecipeDag): {
  id: string
  source: string
  target: string
  data?: Record<string, unknown>
  animated?: boolean
}[] {
  return dag.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: { kind: e.kind },
    animated: e.kind === 'output-ref',
  }))
}
