# Wiki 图计算 + LLM Ingest + Graph Lint 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 wikilink 全链路之上叠加 Louvain 社区发现（写回 communityId + 规则生成社区页）、LLM 提炼式导入、Graph Lint 只读报告与前端面板。

**Architecture:** 全部落在 `src/main/wiki/` 与 `src/main/services/` 既有风格内：louvain 为纯函数无依赖；graph-compute / llm-ingest / graph-lint 三个服务注入 nodeRepo/edgeRepo（内存 repo 可测）；LLM 调用经 IPC 层注入 `sendPromptViaAgent`；IPC 复用 `registerGraphHandlers`；渲染层在既有画布导入入口与侧栏接入。

**Tech Stack:** TypeScript strict、better-sqlite3（内存库做测试）、Vitest、React + Zustand、@xyflow/react。

---

## 验证门槛（每个 commit 前）

```bash
npx tsc --noEmit
npm run test
npm run lint
```
三者全绿才允许 commit。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/main/wiki/louvain.ts` | Louvain 社区发现纯函数（无 IO、无依赖） |
| `src/main/wiki/__tests__/louvain.test.ts` | louvain 单测 |
| `src/main/wiki/graph-compute-service.ts` | 编排 Louvain + 写回 communityId/Level + 社区页差量维护 |
| `src/main/wiki/__tests__/graph-compute-service.test.ts` | graph-compute 单测（内存 repo） |
| `src/main/wiki/llm-ingest-service.ts` | LLM 提炼式导入 |
| `src/main/wiki/__tests__/llm-ingest-service.test.ts` | llm-ingest 单测（stub agentRunner） |
| `src/main/wiki/graph-lint-service.ts` | 聚合断链/孤立/社区异常为 LintReport |
| `src/main/wiki/__tests__/graph-lint-service.test.ts` | lint 单测 |
| `src/shared/types/wiki.ts` | 新增 IngestMode / LintIssue / LintReport / CommunityInfo / ComputeResult |
| `src/shared/types/graph.ts` | `specialPage` 加 `'community'`；GraphNode 加 `communityId` |
| `src/shared/types/ipc.ts` | 新通道类型；`wiki:ingestFiles` 加 `mode` |
| `src/preload/index.ts` | 白名单加新通道 |
| `src/main/ipc/graph.ts` | 注册 `wiki:computeCommunities` / `wiki:lint`；`ingestFiles` 加 `mode` |
| `src/renderer/store/graphStore.ts` | `importWikiFiles` 加 `mode`；新增 `lintGraph` / `computeCommunities` action |
| `src/renderer/components/wiki/LintPanel.tsx` | Lint 面板组件（新增） |
| `src/renderer/canvas/GraphCanvas.tsx` | 导入入口加 LLM 开关；挂 LintPanel |
| `src/renderer/canvas/components/CanvasOverlay.tsx` | 导入菜单项加「LLM 提炼」选项 |

---

## Task 1: 共享类型扩展（wiki.ts + graph.ts + ipc.ts + preload）

**Files:**
- Modify: `src/shared/types/graph.ts`（`specialPage` 加 `'community'`；GraphNode 加 `communityId`）
- Modify: `src/shared/types/wiki.ts`（新增 5 个类型）
- Modify: `src/shared/types/ipc.ts`（新通道 + ingestFiles 加 mode）
- Modify: `src/preload/index.ts`（白名单）
- Test: `src/main/wiki/__tests__/louvain.test.ts`（先用类型占位，Task 2 才实现）

> 说明：本任务先把类型打通，让后续任务的测试能编译。类型先行符合「接口先定」原则；本任务本身无运行逻辑，验证靠 tsc。

- [ ] **Step 1: 修改 `src/shared/types/graph.ts`**

`WikiNodeMeta.specialPage` 改为：
```ts
  /** 特殊页面类型 */
  specialPage?: 'index' | 'log' | 'community'
```
`GraphNode` 在 `communitySummary` 旁新增：
```ts
  /** 预计算的社区摘要 */
  communitySummary?: string
  /** 所属社区 ID（Louvain 计算写回） */
  communityId?: string
  /** 所属社区层级 0=项目级 1=模块级 2=流程级 */
  communityLevel?: number
```

- [ ] **Step 2: 修改 `src/shared/types/wiki.ts`（文件末尾追加）**

```ts
/** 导入模式：规则式 / LLM 提炼式 */
export type IngestMode = 'rule' | 'llm'

/** Graph Lint 单条问题 */
export interface LintIssue {
  kind: 'dangling-link' | 'orphan' | 'community-singleton' | 'community-oversized'
  severity: 'info' | 'warning'
  /** 相关节点（断链时为源节点） */
  nodeId?: string
  message: string
  /** 引导用户如何修复 */
  hint: string
}

/** wiki:lint 返回的报告 */
export interface LintReport {
  issues: LintIssue[]
  stats: { nodeCount: number; edgeCount: number; communityCount: number }
}

/** 单个社区信息 */
export interface CommunityInfo {
  id: string
  memberIds: string[]
  size: number
  internalEdges: number
  externalEdges: number
}

/** wiki:computeCommunities 返回结果 */
export interface ComputeResult {
  communityCount: number
  nodeCount: number
  modularity: number
  communities: CommunityInfo[]
}
```

- [ ] **Step 3: 修改 `src/shared/types/ipc.ts`**

导入新增类型（顶部 import 区，按现有风格追加到 wiki 类型的 import 中）。修改/新增通道签名：
```ts
  'wiki:findDangling': (graphId: string) => Promise<DanglingLink[]>
  'wiki:ingestFiles': (graphId: string, filePaths: string[], mode?: IngestMode) => Promise<IngestResult>
  'wiki:computeCommunities': (graphId: string) => Promise<ComputeResult>
  'wiki:lint': (graphId: string) => Promise<LintReport>
```

- [ ] **Step 4: 修改 `src/preload/index.ts` 白名单**

在 `'wiki:ingestFiles',` 后追加：
```ts
  'wiki:computeCommunities',
  'wiki:lint',
```

- [ ] **Step 5: 验证编译**

Run: `npx tsc --noEmit`
Expected: 零错误（此时新类型尚无使用方，不会报未使用——`@typescript-eslint/no-unused-vars` 针对变量不针对类型导出；preload/ipc 引用的是已存在通道字符串数组与类型导出，均合法）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/graph.ts src/shared/types/wiki.ts src/shared/types/ipc.ts src/preload/index.ts
git commit -m "feat(wiki): 类型扩展 — specialPage+community / communityId / Lint+Compute 类型 / 新 IPC 通道"
```

---

## Task 2: `louvain.ts` 纯函数（TDD）

**Files:**
- Create: `src/main/wiki/louvain.ts`
- Test: `src/main/wiki/__tests__/louvain.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/wiki/__tests__/louvain.test.ts`：
```ts
import { describe, it, expect } from 'vitest'
import { louvain } from '../louvain'

function tri(ids: string[]): Array<{ source: string; target: string }> {
  return [
    { source: ids[0], target: ids[1] },
    { source: ids[1], target: ids[2] },
    { source: ids[0], target: ids[2] },
  ]
}

describe('louvain', () => {
  it('两个三角加一条桥边应分为 2 个社区', () => {
    const g = {
      nodeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      edges: [...tri(['a', 'b', 'c']), ...tri(['d', 'e', 'f']), { source: 'c', target: 'd' }],
    }
    const r = louvain(g, { seed: 42 })
    expect(r.communities().length).toBe(2)
    expect(r.communityOf('a')).toBe(r.communityOf('b'))
    expect(r.communityOf('d')).toBe(r.communityOf('f'))
    expect(r.communityOf('a')).not.toBe(r.communityOf('d'))
  })

  it('空图返回 0 社区、模块度 0', () => {
    const r = louvain({ nodeIds: [], edges: [] })
    expect(r.communities().length).toBe(0)
    expect(r.modularity()).toBe(0)
  })

  it('无边节点各自成社区', () => {
    const r = louvain({ nodeIds: ['x', 'y', 'z'], edges: [] })
    expect(r.communities().length).toBe(3)
  })

  it('固定 seed 结果可复现', () => {
    const g = {
      nodeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      edges: [...tri(['a', 'b', 'c']), ...tri(['d', 'e', 'f']), { source: 'c', target: 'd' }],
    }
    const r1 = louvain(g, { seed: 7 })
    const r2 = louvain(g, { seed: 7 })
    g.nodeIds.forEach((id) => expect(r1.communityOf(id)).toBe(r2.communityOf(id)))
    expect(r1.modularity()).toBeCloseTo(r2.modularity(), 10)
  })

  it('communityOf 对未知节点返回 undefined 行为外的自身社区', () => {
    const r = louvain({ nodeIds: ['a'], edges: [] })
    expect(r.communityOf('a')).toBeDefined()
  })

  it('悬空边（引用不存在节点）被过滤不报错', () => {
    const r = louvain({ nodeIds: ['a', 'b'], edges: [{ source: 'a', target: 'ghost' }] })
    expect(r.communityOf('a')).toBeDefined()
    expect(r.communityOf('b')).toBeDefined()
  })

  it('1000 节点玩具图在 2 秒内完成', () => {
    const nodeIds = Array.from({ length: 1000 }, (_, i) => `n${i}`)
    const edges: Array<{ source: string; target: string }> = []
    // 20 个 50 节点团，团内全连太重，改为环+少量跨团边
    for (let c = 0; c < 20; c++) {
      const base = c * 50
      for (let i = 0; i < 50; i++) {
        edges.push({ source: `n${base + i}`, target: `n${base + ((i + 1) % 50)}` })
        edges.push({ source: `n${base + i}`, target: `n${base + ((i + 2) % 50)}` })
      }
      edges.push({ source: `n${base}`, target: `n${(base + 50) % 1000}` })
    }
    const start = Date.now()
    louvain({ nodeIds, edges }, { seed: 1 })
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/wiki/__tests__/louvain.test.ts`
Expected: FAIL，`louvain is not a function` / 模块无导出。

- [ ] **Step 3: 实现 `louvain.ts`**

标准两阶段 Louvain（局部移动 + 社区聚合），带确定性随机（种子化 LCG）。实现要点：内部邻接表用 `Map<string, Map<string, number>>`；模块度增益 ΔQ 标准公式；迭代至增益 < 1e-7；聚合阶段把社区折叠为超节点，循环至不再变化。完整实现：

```ts
/**
 * Louvain 社区发现（纯函数，无 IO 无第三方依赖）
 *
 * 输入无向带权图，输出稳定的社区划分。固定 seed 时结果可复现。
 * resolution 控制粒度（>1 更细，<1 更粗），默认 1.0。
 * 悬空边（引用不存在节点）在构图时被过滤。
 */

export interface LouvainGraph {
  nodeIds: string[]
  edges: Array<{ source: string; target: string; weight?: number }>
}

export interface CommunityAssignment {
  communityOf(nodeId: string): string
  communities(): string[]
  modularity(): number
}

export interface LouvainOptions {
  resolution?: number
  seed?: number
}

/** 种子化线性同余随机数（确定性） */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function louvain(graph: LouvainGraph, options: LouvainOptions = {}): CommunityAssignment {
  const resolution = options.resolution ?? 1.0
  const rand = lcg(options.seed ?? 42)

  // 邻接表：node -> (neighbor -> weight)
  const nodes = new Set(graph.nodeIds)
  const adj = new Map<string, Map<string, number>>()
  for (const id of graph.nodeIds) adj.set(id, new Map())
  let m2 = 0 // 2m = 总权重*2
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) continue
    if (e.source === e.target) continue
    const w = e.weight ?? 1
    adj.get(e.source)!.set(e.target, (adj.get(e.source)!.get(e.target) ?? 0) + w)
    adj.get(e.target)!.set(e.source, (adj.get(e.target)!.get(e.source) ?? 0) + w)
    m2 += 2 * w
  }

  const ids = graph.nodeIds.slice()
  if (ids.length === 0) {
    return { communityOf: () => '', communities: () => [], modularity: () => 0 }
  }

  // 初始：每节点一社区
  let nodeCommunity = new Map<string, number>()
  ids.forEach((id, i) => nodeCommunity.set(id, i))

  const degree = new Map<string, number>()
  for (const id of ids) {
    let d = 0
    for (const w of adj.get(id)!.values()) d += w
    degree.set(id, d)
  }

  // 当前图（会随聚合变化）：节点为社区编号
  let currentAdj = adj
  let currentDegree = degree
  let currentIds = ids
  let currentM2 = m2

  // 每个原始节点到当前层节点的映射
  let membership = new Map<string, string>() // originalId -> currentNodeId
  ids.forEach((id) => membership.set(id, id))

  const hierarchy: Array<Map<string, string>> = [] // 每层 originalOrSuper -> community 标签

  let improved = true
  while (improved && currentIds.length > 1) {
    improved = false
    // 局部移动阶段
    let communityOfNode = new Map<string, number>()
    currentIds.forEach((id, i) => communityOfNode.set(id, i))

    // 社区总度数
    const commDegree = new Map<number, number>()
    for (const id of currentIds) {
      const c = communityOfNode.get(id)!
      commDegree.set(c, (commDegree.get(c) ?? 0) + (currentDegree.get(id) ?? 0))
    }

    let localMoved = true
    let guard = 0
    while (localMoved && guard < 100) {
      localMoved = false
      guard++
      const order = currentIds.slice()
      // 确定性洗牌
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      for (const node of order) {
        const nodeDeg = currentDegree.get(node) ?? 0
        const curComm = communityOfNode.get(node)!
        // 统计邻居社区权重
        const neighCommWeight = new Map<number, number>()
        for (const [nb, w] of currentAdj.get(node)!.entries()) {
          const c = communityOfNode.get(nb)!
          neighCommWeight.set(c, (neighCommWeight.get(c) ?? 0) + w)
        }
        // 从当前社区移除
        commDegree.set(curComm, (commDegree.get(curComm) ?? 0) - nodeDeg)
        let bestComm = curComm
        let bestGain = 0
        for (const [c, kIn] of neighCommWeight.entries()) {
          const tot = commDegree.get(c) ?? 0
          const gain = kIn - (resolution * tot * nodeDeg) / currentM2
          if (gain > bestGain + 1e-10) {
            bestGain = gain
            bestComm = c
          }
        }
        commDegree.set(bestComm, (commDegree.get(bestComm) ?? 0) + nodeDeg)
        if (bestComm !== curComm) {
          communityOfNode.set(node, bestComm)
          localMoved = true
          improved = true
        }
      }
    }

    // 记录本层归属（当前节点 -> 社区标签）
    const layerMap = new Map<string, string>()
    for (const id of currentIds) layerMap.set(id, String(communityOfNode.get(id)))
    hierarchy.push(layerMap)

    // 若所有节点各自为社区或社区数未减少，停止
    const commCount = new Set(communityOfNode.values()).size
    if (commCount === currentIds.length) break

    // 聚合阶段：社区折叠为超节点
    const newIds = [...new Set(communityOfNode.values())].map(String)
    const remap = new Map<number, string>()
    newIds.forEach((nid) => remap.set(Number(nid), nid))
    const newAdj = new Map<string, Map<string, number>>()
    for (const nid of newIds) newAdj.set(nid, new Map())
    const newDegree = new Map<string, number>()
    for (const id of currentIds) {
      const c = remap.get(communityOfNode.get(id)!)!
      newDegree.set(c, (newDegree.get(c) ?? 0) + (currentDegree.get(id) ?? 0))
      for (const [nb, w] of currentAdj.get(id)!.entries()) {
        const nbC = remap.get(communityOfNode.get(nb)!)!
        if (nbC === c) continue
        newAdj.get(c)!.set(nbC, (newAdj.get(c)!.get(nbC) ?? 0) + w)
      }
    }
    currentAdj = newAdj
    currentDegree = newDegree
    currentIds = newIds
    // currentM2 不变
  }

  // 回推：原始节点 -> 最终社区标签
  const finalCommunity = new Map<string, string>()
  for (const orig of ids) {
    let cur = orig
    for (const layer of hierarchy) {
      const next = layer.get(cur)
      if (next === undefined) break
      cur = next
    }
    finalCommunity.set(orig, cur)
  }

  // 模块度（基于原始图）
  const commSum = new Map<string, { inW: number; totW: number }>()
  for (const id of ids) {
    const c = finalCommunity.get(id)!
    if (!commSum.has(c)) commSum.set(c, { inW: 0, totW: 0 })
    commSum.get(c)!.totW += degree.get(id) ?? 0
  }
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target) || e.source === e.target) continue
    if (finalCommunity.get(e.source) === finalCommunity.get(e.target)) {
      const c = finalCommunity.get(e.source)!
      commSum.get(c)!.inW += 2 * (e.weight ?? 1)
    }
  }
  let q = 0
  if (m2 > 0) {
    for (const { inW, totW } of commSum.values()) {
      q += inW / m2 - resolution * (totW / m2) * (totW / m2)
    }
  }

  const communityList = [...new Set(finalCommunity.values())]
  return {
    communityOf: (nodeId: string) => finalCommunity.get(nodeId) ?? '',
    communities: () => communityList,
    modularity: () => q,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/wiki/__tests__/louvain.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 验证门槛 + Commit**

```bash
npx tsc --noEmit && npm run lint
git add src/main/wiki/louvain.ts src/main/wiki/__tests__/louvain.test.ts
git commit -m "feat(wiki): Louvain 社区发现纯函数（确定性、可带权、可复现）"
```

---

## Task 3: `graph-compute-service.ts`（TDD）

**Files:**
- Create: `src/main/wiki/graph-compute-service.ts`
- Test: `src/main/wiki/__tests__/graph-compute-service.test.ts`

依赖：louvain（Task 2）、WikiLinkService、WikiIndexService、`normalizeWikiTitle`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { GraphComputeService } from '../graph-compute-service'
import type { GraphNode, GraphEdge } from '@shared/types'

function makeNode(id: string, title: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, type: 'wiki-page', status: 'draft', title,
    graphId: 'g1', graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: '', updatedAt: '',
    ...extra,
  } as GraphNode
}

class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const n = { ...data, id: `n${this.nodes.size}`, createdAt: '', updatedAt: '' } as GraphNode
    this.nodes.set(n.id, n)
    return n
  }
  update(id: string, data: Partial<GraphNode>): GraphNode {
    const n = this.nodes.get(id)!
    const u = { ...n, ...data }
    this.nodes.set(id, u)
    return u
  }
  delete(id: string) { this.nodes.delete(id) }
}
class MemEdgeRepo {
  edges = new Map<string, GraphEdge>()
  private seq = 0
  create(data: Omit<GraphEdge, 'id'>): GraphEdge {
    const e = { ...data, id: `e${this.seq++}` } as GraphEdge
    this.edges.set(e.id, e)
    return e
  }
  delete(id: string) { this.edges.delete(id) }
  listByGraph = (gid: string) => [...this.edges.values()].filter((e) => e.graphId === gid)
}

describe('GraphComputeService.computeCommunities', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo
  beforeEach(() => { nodeRepo = new MemNodeRepo(); edgeRepo = new MemEdgeRepo() })

  function link(a: string, b: string) {
    edgeRepo.create({ source: a, target: b, edgeType: 'wiki-link', graphId: 'g1' })
  }

  it('空图 / 节点数<2 返回空结果且不写回', () => {
    nodeRepo.nodes.set('a', makeNode('a', 'A'))
    const r = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    expect(r.communityCount).toBe(0)
    expect(nodeRepo.nodes.get('a')!.communityId).toBeUndefined()
  })

  it('两团各成社区并写回 communityId，且生成社区页', () => {
    ;['a', 'b', 'c', 'd', 'e', 'f'].forEach((id) => nodeRepo.nodes.set(id, makeNode(id, id.toUpperCase())))
    link('a', 'b'); link('b', 'c'); link('a', 'c')
    link('d', 'e'); link('e', 'f'); link('d', 'f')
    link('c', 'd')
    const r = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    expect(r.communityCount).toBe(2)
    expect(nodeRepo.nodes.get('a')!.communityId).toBe(nodeRepo.nodes.get('b')!.communityId)
    expect(nodeRepo.nodes.get('a')!.communityId).not.toBe(nodeRepo.nodes.get('d')!.communityId)
    // 社区页生成
    const communityPages = [...nodeRepo.nodes.values()].filter(
      (n) => (n.wikiMeta as { specialPage?: string } | undefined)?.specialPage === 'community',
    )
    expect(communityPages.length).toBe(2)
  })

  it('幂等：连跑两次 communityId 稳定、社区页不重复', () => {
    ;['a', 'b', 'c', 'd', 'e', 'f'].forEach((id) => nodeRepo.nodes.set(id, makeNode(id, id.toUpperCase())))
    link('a', 'b'); link('b', 'c'); link('a', 'c')
    link('d', 'e'); link('e', 'f'); link('d', 'f')
    link('c', 'd')
    const r1 = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    const firstIds = new Map([...nodeRepo.nodes.values()].map((n) => [n.id, n.communityId]))
    const r2 = GraphComputeService.computeCommunities('g1', nodeRepo, edgeRepo)
    expect(r2.communityCount).toBe(r1.communityCount)
    const communityPages = [...nodeRepo.nodes.values()].filter(
      (n) => (n.wikiMeta as { specialPage?: string } | undefined)?.specialPage === 'community',
    )
    expect(communityPages.length).toBe(2)
    for (const [id, cid] of firstIds) {
      if (cid) expect(nodeRepo.nodes.get(id)!.communityId).toBe(cid)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/wiki/__tests__/graph-compute-service.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `graph-compute-service.ts`**

```ts
/**
 * 图计算服务：编排 Louvain 社区发现 + 写回 + 社区页差量维护。
 *
 * 仅基于 edge_type='wiki-link' 的边构图。社区页规则化生成（非 LLM），
 * 采用差量更新：新社区建页、已存在重写正文、消失的社区删页，避免
 * 引用社区页的 wikilink 断裂。注入内存 repo 即可单测。
 */

import type { GraphEdge, GraphNode, WikiNodeMeta } from '@shared/types'
import type { CommunityInfo, ComputeResult } from '@shared/types/wiki'
import { louvain } from './louvain'
import { stringifyWikiMarkdown } from './markdown-utils'

export interface ComputeNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode
  update(id: string, data: Partial<GraphNode>): GraphNode
  delete(id: string): void
}
export interface ComputeEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

const COMMUNITY_PAGE_TAG = 'community'

export class GraphComputeService {
  static computeCommunities(graphId: string, nodeRepo: ComputeNodeRepo, edgeRepo: ComputeEdgeRepo): ComputeResult {
    const pages = nodeRepo.listByGraph(graphId).filter((n) => n.type === 'wiki-page')
    const edges = edgeRepo.listByGraph(graphId).filter((e) => e.edgeType === 'wiki-link')

    const empty: ComputeResult = { communityCount: 0, nodeCount: pages.length, modularity: 0, communities: [] }
    if (pages.length < 2 || edges.length === 0) return empty

    const pageIds = new Set(pages.map((p) => p.id))
    const louvainEdges = edges
      .filter((e) => pageIds.has(e.source) && pageIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, weight: e.strength ?? 1 }))

    const assignment = louvain({ nodeIds: [...pageIds], edges: louvainEdges }, { seed: 42 })
    const communityIds = assignment.communities()
    if (communityIds.length === 0) return empty

    // 分组
    const members = new Map<string, string[]>()
    for (const cid of communityIds) members.set(cid, [])
    for (const pid of pageIds) {
      const cid = assignment.communityOf(pid)
      if (cid) members.get(cid)!.push(pid)
    }

    // 写回 communityId / communityLevel（按社区占比分级）
    const total = pageIds.size
    for (const [cid, ids] of members) {
      const ratio = ids.length / total
      const level = ratio > 0.5 ? 0 : ratio > 0.1 ? 1 : 2
      for (const id of ids) {
        nodeRepo.update(id, { communityId: cid, communityLevel: level })
      }
    }

    // 统计每社区内/外边
    const commOf = (id: string) => assignment.communityOf(id)
    const communities: CommunityInfo[] = []
    for (const [cid, ids] of members) {
      let internal = 0
      let external = 0
      const idSet = new Set(ids)
      for (const e of edges) {
        if (idSet.has(e.source) && idSet.has(e.target)) internal++
        else if (idSet.has(e.source) || idSet.has(e.target)) external++
      }
      communities.push({ id: cid, memberIds: ids, size: ids.length, internalEdges: internal, externalEdges: external })
    }

    // 社区页差量维护
    this.syncCommunityPages(graphId, pages, communities, members, nodeRepo, commOf)

    return { communityCount: communityIds.length, nodeCount: total, modularity: assignment.modularity(), communities }
  }

  private static syncCommunityPages(
    graphId: string,
    pages: GraphNode[],
    communities: CommunityInfo[],
    members: Map<string, string[]>,
    nodeRepo: ComputeNodeRepo,
    commOf: (id: string) => string,
  ): void {
    const titleOf = new Map(pages.map((p) => [p.id, p.title]))
    // 代表词 = 社区内被链接次数最多者（简单取成员标题字典序最小保证确定性）
    const existingCommunityPages = nodeRepo
      .listByGraph(graphId)
      .filter((n) => (n.wikiMeta as WikiNodeMeta | undefined)?.specialPage === COMMUNITY_PAGE_TAG)
    const byCommunityId = new Map(
      existingCommunityPages.map((n) => [((n.wikiMeta as WikiNodeMeta).frontmatter?.communityId as string) ?? '', n]),
    )

    const aliveIds = new Set(communities.map((c) => c.id))
    // 删除消失的社区页
    for (const [cid, page] of byCommunityId) {
      if (cid && !aliveIds.has(cid)) nodeRepo.delete(page.id)
    }

    for (const c of communities) {
      const ids = members.get(c.id)!
      const repTitle = ids.map((id) => titleOf.get(id) ?? id).sort()[0] ?? c.id
      const memberLinks = ids
        .map((id) => `- [[${titleOf.get(id) ?? id}]]`)
        .sort()
        .join('\n')
      const frontmatter: Record<string, unknown> = {
        title: `社区 · ${repTitle}`,
        specialPage: 'community',
        communityId: c.id,
      }
      const body = `# 社区 · ${repTitle}\n\n> 本页由图计算自动生成，请勿手工编辑。\n\n## 成员（${c.size}）\n${memberLinks}\n\n## 统计\n- 内部链接：${c.internalEdges} · 外部链接：${c.externalEdges}`
      const wikiContent = stringifyWikiMarkdown(frontmatter, body)

      const existing = byCommunityId.get(c.id)
      const wikiMeta: WikiNodeMeta = { specialPage: 'community', frontmatter, tags: ['special', 'community'] }
      if (existing) {
        nodeRepo.update(existing.id, { title: `社区 · ${repTitle}`, wikiContent, wikiMeta: wikiMeta as Record<string, unknown> })
      } else {
        nodeRepo.create({
          type: 'wiki-page', status: 'confirmed', title: `社区 · ${repTitle}`,
          graphId, graphType: pages[0]?.graphType ?? 'online',
          position: { x: 0, y: 0 }, wikiContent,
          wikiMeta: wikiMeta as Record<string, unknown>,
        })
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/wiki/__tests__/graph-compute-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 验证门槛 + Commit**

```bash
npx tsc --noEmit && npm run lint
git add src/main/wiki/graph-compute-service.ts src/main/wiki/__tests__/graph-compute-service.test.ts
git commit -m "feat(wiki): GraphComputeService — Louvain 编排 + communityId 写回 + 社区页差量维护"
```

---

## Task 4: `llm-ingest-service.ts`（TDD）

**Files:**
- Create: `src/main/wiki/llm-ingest-service.ts`
- Test: `src/main/wiki/__tests__/llm-ingest-service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { LlmIngestService, type AgentRunner } from '../llm-ingest-service'
import { IngestService } from '../ingest-service'
import type { GraphNode, GraphEdge } from '@shared/types'

class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  private seq = 0
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
    const n = { ...data, id: `n${this.seq++}`, createdAt: '', updatedAt: '' } as GraphNode
    this.nodes.set(n.id, n); return n
  }
  update(id: string, data: Partial<GraphNode>): GraphNode {
    const u = { ...this.nodes.get(id)!, ...data }; this.nodes.set(id, u); return u
  }
}
class MemEdgeRepo {
  edges = new Map<string, GraphEdge>(); private seq = 0
  create(d: Omit<GraphEdge, 'id'>): GraphEdge { const e = { ...d, id: `e${this.seq++}` } as GraphEdge; this.edges.set(e.id, e); return e }
  delete(id: string) { this.edges.delete(id) }
  listByGraph = (gid: string) => [...this.edges.values()].filter((e) => e.graphId === gid)
}

const readFile = async (p: string) => `raw content of ${p}`

describe('LlmIngestService.ingestWithLlm', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo
  beforeEach(() => { nodeRepo = new MemNodeRepo(); edgeRepo = new MemEdgeRepo() })

  it('LLM 输出带 frontmatter 时按标题新建 draft 节点', async () => {
    const runner: AgentRunner = async () => '---\ntitle: 支付流程\n---\n\n# 支付流程\n\n见 [[订单]]。'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(1)
    expect(r.created[0].title).toBe('支付流程')
  })

  it('同名（大小写不敏感）追加而非新建', async () => {
    nodeRepo.nodes.set('x', {
      id: 'x', type: 'wiki-page', status: 'draft', title: '支付流程',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      wikiContent: '# 旧内容', createdAt: '', updatedAt: '',
    } as GraphNode)
    const runner: AgentRunner = async () => '---\ntitle: 支付流程\n---\n\n# 支付流程\n\n新增段落。'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(0)
    expect(r.updated.length).toBe(1)
    expect(nodeRepo.nodes.get('x')!.wikiContent).toContain('旧内容')
    expect(nodeRepo.nodes.get('x')!.wikiContent).toContain('新增段落')
  })

  it('frontmatter 非法时回退：文件名做标题并记 ingestWarning', async () => {
    const runner: AgentRunner = async () => '---\n: bad yaml [\n---\n\n正文内容'
    const r = await LlmIngestService.ingestWithLlm('g1', ['/dir/订单.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.created.length).toBe(1)
    const node = nodeRepo.nodes.get(r.created[0].id)!
    expect(node.title).toBe('订单')
    expect((node.wikiMeta as { ingestWarning?: string }).ingestWarning).toBeDefined()
  })

  it('单文件失败不阻塞整批', async () => {
    let call = 0
    const runner: AgentRunner = async () => {
      call++
      if (call === 1) throw new Error('agent timeout')
      return '---\ntitle: 好页面\n---\n\n# 好页面'
    }
    const r = await LlmIngestService.ingestWithLlm('g1', ['/bad.md', '/good.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(r.failed.length).toBe(1)
    expect(r.created.length).toBe(1)
  })

  it('prompt 中包含已有页面标题供 wikilink 对齐', async () => {
    nodeRepo.nodes.set('e1', {
      id: 'e1', type: 'wiki-page', status: 'confirmed', title: '库存',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, createdAt: '', updatedAt: '',
    } as GraphNode)
    let seenPrompt = ''
    const runner: AgentRunner = async (p) => { seenPrompt = p; return '---\ntitle: X\n---\n\n# X' }
    await LlmIngestService.ingestWithLlm('g1', ['/a.md'], 'online', nodeRepo, edgeRepo, readFile, runner)
    expect(seenPrompt).toContain('库存')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/wiki/__tests__/llm-ingest-service.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `llm-ingest-service.ts`**

```ts
/**
 * LLM 提炼式导入服务
 *
 * 与规则式 IngestService 差异仅在内容来源：原文经 LLM 提炼为
 * 带 frontmatter 与建议 wikilink 的 wiki 页。同名追加、draft 新建、
 * 第二遍统一落边等落库语义完全复用规则式。AgentRunner 由 IPC 层注入
 * （sendPromptViaAgent），测试替换为 stub。
 */

import type { GraphEdge, GraphNode, GraphType } from '@shared/types'
import type { IngestResult } from '@shared/types/wiki'
import { basename } from 'path'
import { normalizeWikiTitle, parseWikiMarkdown } from './markdown-utils'
import { IngestService, type IngestNodeRepo, type IngestEdgeRepo, type ReadFileFn } from './ingest-service'

export type AgentRunner = (prompt: string) => Promise<string>

const MAX_EXISTING_TITLES = 200

function fileBaseName(filePath: string): string {
  return basename(filePath).replace(/\.(md|markdown|txt)$/i, '')
}

function buildPrompt(raw: string, sourcePath: string, existingTitles: string[]): string {
  const titleList = existingTitles.slice(0, MAX_EXISTING_TITLES).map((t) => `- ${t}`).join('\n')
  return `你是知识工程师。把下面的原始资料提炼为一页 wiki 页面。

要求：
1. 第一行输出 YAML frontmatter（--- 包裹），必须含 title 字段。
2. frontmatter 之后输出 markdown 正文，首行为与 title 一致的 H1。
3. 正文中用 [[标题]] 形式引用相关概念；优先引用下列已有页面标题（逐字使用）：
${titleList || '（无）'}
4. 只输出 markdown，不要任何解释。

原始资料（来源：${sourcePath}）：

${raw}`
}

export class LlmIngestService {
  static async ingestWithLlm(
    graphId: string,
    filePaths: string[],
    graphType: GraphType,
    nodeRepo: IngestNodeRepo,
    edgeRepo: IngestEdgeRepo,
    readFile: ReadFileFn,
    agentRunner: AgentRunner,
  ): Promise<IngestResult> {
    const existingTitles = nodeRepo
      .listByGraph(graphId)
      .filter((n) => n.type === 'wiki-page')
      .map((n) => n.title)

    // 第一遍：逐文件 LLM 提炼为 markdown 文本
    const refined: Array<{ filePath: string; markdown: string; warning?: string }> = []
    const result: IngestResult = { created: [], updated: [], failed: [] }

    for (const filePath of filePaths) {
      try {
        const raw = await readFile(filePath)
        const output = await agentRunner(buildPrompt(raw, filePath, existingTitles))
        // 验证 frontmatter 可解析；非法则回退包装
        let markdown = output
        let warning: string | undefined
        try {
          parseWikiMarkdown(output)
        } catch {
          warning = 'LLM 输出 frontmatter 无法解析，已回退为文件名标题 + 原文整体导入'
          const safeBody = output.replace(/^---[\s\S]*?---/, '').trim()
          markdown = `# ${fileBaseName(filePath)}\n\n${safeBody}`
        }
        refined.push({ filePath, markdown, ...(warning ? { warning } : {}) })
      } catch (err) {
        result.failed.push({ file: filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 第二遍：复用规则式落库（同名追加/新建/落边）。为注入 warning，
    // 这里自行调用与规则式等价的逐文件写入，再统一落边。
    const touched: string[] = []
    for (const item of refined) {
      try {
        const r = await IngestService.ingestFiles(
          graphId, [item.filePath], graphType, nodeRepo, edgeRepo,
          async () => item.markdown,
        )
        result.created.push(...r.created)
        result.updated.push(...r.updated)
        result.failed.push(...r.failed)
        const id = r.created[0]?.id ?? r.updated[0]?.id
        if (id) {
          touched.push(id)
          if (item.warning) {
            const n = nodeRepo.findById(id)
            if (n) nodeRepo.update(id, { wikiMeta: { ...(n.wikiMeta ?? {}), ingestWarning: item.warning } })
          }
        }
      } catch (err) {
        result.failed.push({ file: item.filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return result
  }
}
```

> 注：`ingestWithLlm` 内部对每个文件调用一次 `IngestService.ingestFiles`（单文件批量），其内部已做同名追加/新建 + syncNodeLinks 落边。同批互链在逐文件场景下边会在后续文件的 sync 中自然建立（因 resolveWikiLink 实时按标题解析），无需额外第二遍——规则式的「第二遍」是为批量同批互链，此处逐文件已覆盖。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/wiki/__tests__/llm-ingest-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 验证门槛 + Commit**

```bash
npx tsc --noEmit && npm run lint
git add src/main/wiki/llm-ingest-service.ts src/main/wiki/__tests__/llm-ingest-service.test.ts
git commit -m "feat(wiki): LlmIngestService — LLM 提炼式导入（复用规则式落库语义）"
```

---

## Task 5: `graph-lint-service.ts`（TDD）

**Files:**
- Create: `src/main/wiki/graph-lint-service.ts`
- Test: `src/main/wiki/__tests__/graph-lint-service.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { GraphLintService } from '../graph-lint-service'
import type { GraphNode, GraphEdge } from '@shared/types'

function wikiNode(id: string, title: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, type: 'wiki-page', status: 'draft', title, graphId: 'g1', graphType: 'online',
    position: { x: 0, y: 0 }, createdAt: '', updatedAt: '', ...extra,
  } as GraphNode
}
class MemNodeRepo {
  nodes = new Map<string, GraphNode>()
  findById = (id: string) => this.nodes.get(id) ?? null
  listByGraph = (gid: string) => [...this.nodes.values()].filter((n) => n.graphId === gid)
}
class MemEdgeRepo {
  edges: GraphEdge[] = []
  listByGraph = (gid: string) => this.edges.filter((e) => e.graphId === gid)
}

describe('GraphLintService.lint', () => {
  let nodeRepo: MemNodeRepo
  let edgeRepo: MemEdgeRepo
  beforeEach(() => { nodeRepo = new MemNodeRepo(); edgeRepo = new MemEdgeRepo() })

  it('断链 → dangling-link', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { wikiContent: '见 [[不存在的页]]' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'dangling-link')).toBe(true)
  })

  it('无入边无出边的普通页 → orphan；特殊页不计', () => {
    nodeRepo.nodes.set('a', wikiNode('a', '孤儿页'))
    nodeRepo.nodes.set('idx', wikiNode('idx', 'Graph Index', {
      wikiMeta: { specialPage: 'index' },
    }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    const orphans = r.issues.filter((i) => i.kind === 'orphan')
    expect(orphans.length).toBe(1)
    expect(orphans[0].nodeId).toBe('a')
  })

  it('有边的页面不算 orphan', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A'))
    nodeRepo.nodes.set('b', wikiNode('b', 'B'))
    edgeRepo.edges.push({ id: 'e1', source: 'a', target: 'b', edgeType: 'wiki-link', graphId: 'g1' })
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'orphan')).toBe(false)
  })

  it('单节点社区 → community-singleton', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { communityId: 'c1', communityLevel: 2 }))
    nodeRepo.nodes.set('b', wikiNode('b', 'B', { communityId: 'c2', communityLevel: 2 }))
    nodeRepo.nodes.set('c', wikiNode('c', 'C', { communityId: 'c2', communityLevel: 2 }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'community-singleton')).toBe(true)
  })

  it('超大社区（>50%）→ community-oversized', () => {
    for (let i = 0; i < 4; i++) nodeRepo.nodes.set(`n${i}`, wikiNode(`n${i}`, `N${i}`, { communityId: 'big' }))
    nodeRepo.nodes.set('x', wikiNode('x', 'X', { communityId: 'small' }))
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.issues.some((i) => i.kind === 'community-oversized')).toBe(true)
  })

  it('stats 正确统计节点/边/社区数', () => {
    nodeRepo.nodes.set('a', wikiNode('a', 'A', { communityId: 'c1' }))
    nodeRepo.nodes.set('b', wikiNode('b', 'B', { communityId: 'c1' }))
    edgeRepo.edges.push({ id: 'e1', source: 'a', target: 'b', edgeType: 'wiki-link', graphId: 'g1' })
    const r = GraphLintService.lint('g1', nodeRepo, edgeRepo)
    expect(r.stats.nodeCount).toBe(2)
    expect(r.stats.edgeCount).toBe(1)
    expect(r.stats.communityCount).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/wiki/__tests__/graph-lint-service.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `graph-lint-service.ts`**

```ts
/**
 * Graph Lint 服务：只读聚合断链、孤立节点、社区异常为 LintReport。
 * 不写库、不缓存、不修复。修复动作全部回到既有入口（建页/改链/重算社区）。
 */

import type { GraphEdge, GraphNode, WikiNodeMeta } from '@shared/types'
import type { LintIssue, LintReport } from '@shared/types/wiki'
import { WikiLinkService } from '../services/wiki-link-service'

export interface LintNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
}
export interface LintEdgeRepo {
  listByGraph(graphId: string): GraphEdge[]
}

const OVERSIZED_RATIO = 0.5

export class GraphLintService {
  static lint(graphId: string, nodeRepo: LintNodeRepo, edgeRepo: LintEdgeRepo): LintReport {
    const issues: LintIssue[] = []
    const pages = nodeRepo.listByGraph(graphId).filter((n) => n.type === 'wiki-page')
    const edges = edgeRepo.listByGraph(graphId).filter((e) => e.edgeType === 'wiki-link')

    // 1. 断链
    for (const d of WikiLinkService.findDanglingLinks(graphId, nodeRepo)) {
      issues.push({
        kind: 'dangling-link', severity: 'warning', nodeId: d.fromNodeId,
        message: `「${d.fromTitle}」引用了不存在的页面 [[${d.targetTitle}]]`,
        hint: '创建该页面，或修正链接标题',
      })
    }

    // 2. 孤立节点（特殊页除外）
    const hasEdge = new Set<string>()
    for (const e of edges) { hasEdge.add(e.source); hasEdge.add(e.target) }
    for (const p of pages) {
      if ((p.wikiMeta as WikiNodeMeta | undefined)?.specialPage) continue
      if (!hasEdge.has(p.id)) {
        issues.push({
          kind: 'orphan', severity: 'info', nodeId: p.id,
          message: `「${p.title}」没有任何 wikilink 连接`,
          hint: '在相关页面中添加指向它的 [[链接]]，或在它正文中链接到其他页面',
        })
      }
    }

    // 3. 社区异常
    const byCommunity = new Map<string, GraphNode[]>()
    for (const p of pages) {
      if (!p.communityId) continue
      if (!byCommunity.has(p.communityId)) byCommunity.set(p.communityId, [])
      byCommunity.get(p.communityId)!.push(p)
    }
    const total = pages.length
    for (const [cid, members] of byCommunity) {
      if (members.length === 1) {
        issues.push({
          kind: 'community-singleton', severity: 'info', nodeId: members[0].id,
          message: `「${members[0].title}」自成一社区，疑似游离`,
          hint: '增加它与其它页面之间的 wikilink，重新计算社区',
        })
      } else if (total > 0 && members.length / total > OVERSIZED_RATIO) {
        issues.push({
          kind: 'community-oversized', severity: 'warning',
          message: `社区 ${cid} 含 ${members.length}/${total} 页（>${OVERSIZED_RATIO * 100}%），疑似未分化`,
          hint: '调高 Louvain resolution 细分，或检查是否有过渡互联的枢纽页',
        })
      }
    }

    return {
      issues,
      stats: { nodeCount: pages.length, edgeCount: edges.length, communityCount: byCommunity.size },
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/wiki/__tests__/graph-lint-service.test.ts`
Expected: PASS。

- [ ] **Step 5: 验证门槛 + Commit**

```bash
npx tsc --noEmit && npm run lint
git add src/main/wiki/graph-lint-service.ts src/main/wiki/__tests__/graph-lint-service.test.ts
git commit -m "feat(wiki): GraphLintService — 断链/孤立/社区异常只读聚合"
```

---

## Task 6: IPC 接线（graph.ts）

**Files:**
- Modify: `src/main/ipc/graph.ts`
- Test: `src/main/ipc/__tests__/`（沿用现有 wiki IPC 测试文件，追加用例）

- [ ] **Step 1: 在 `src/main/ipc/graph.ts` 引入新服务与依赖**

顶部 import 区追加：
```ts
import { GraphComputeService } from '../wiki/graph-compute-service'
import { GraphLintService } from '../wiki/graph-lint-service'
import { LlmIngestService } from '../wiki/llm-ingest-service'
import type { IngestMode } from '@shared/types/wiki'
```
> LLM 模式的 `agentRunner` 需要 `AgentManager`。查看 `registerGraphHandlers` 当前签名，若无法直接拿到 AgentManager，则在本文件新增一个可选的 `agentRunner` 参数由 `registerIpcHandlers` 注入（参照 `sendPromptViaAgent` 在 mindmap IPC 的注入方式）。

- [ ] **Step 2: 修改 `wiki:ingestFiles` 加 `mode`，新增两个通道**

把 `wiki:ingestFiles` handler 改为接受 `mode?: IngestMode`，默认 `'rule'`；当 `mode === 'llm'` 时校验 `agentRunner` 存在（否则抛「LLM 不可用，请改用规则式」），并调用 `LlmIngestService.ingestWithLlm`，`agentRunner` 包装为 `(prompt) => sendPromptViaAgent(agentManager, graphData.graph.projectPath ?? '', prompt, { timeoutMs: 120_000 })`。

在 `wiki:ingestFiles` 之后追加：
```ts
  typedHandle('wiki:computeCommunities', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    return GraphComputeService.computeCommunities(graphId, nodeRepo, edgeRepo)
  })

  typedHandle('wiki:lint', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    return GraphLintService.lint(graphId, nodeRepo, edgeRepo)
  })
```

- [ ] **Step 3: 写/改 IPC 测试**

沿用现有 wiki IPC 测试（真实 better-sqlite3 内存库）追加：
- `wiki:ingestFiles` 不传 `mode` 时按规则式执行（回归）
- `mode:'rule'` 显式规则式
- `mode:'llm'` 且注入 stub agentRunner 时走 LLM 路径
- `mode:'llm'` 未注入 agentRunner → 抛错
- `wiki:computeCommunities` / `wiki:lint` 参数校验（空 graphId 抛错）+ happy path

- [ ] **Step 4: 跑测试**

Run: `npx vitest run src/main/ipc`
Expected: PASS（含新增用例）。

- [ ] **Step 5: 验证门槛 + Commit**

```bash
npx tsc --noEmit && npm run lint && npm run test
git add src/main/ipc/graph.ts src/main/ipc/__tests__/
git commit -m "feat(wiki): IPC 接线 — ingestFiles 加 mode + computeCommunities/lint 通道"
```

---

## Task 7: 渲染层（graphStore + LintPanel + 画布入口）

**Files:**
- Modify: `src/renderer/store/graphStore.ts`
- Create: `src/renderer/components/wiki/LintPanel.tsx`
- Modify: `src/renderer/canvas/GraphCanvas.tsx`
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`
- Test: `src/renderer/store/__tests__/graphStore.test.ts`（追加）、`src/renderer/components/wiki/__tests__/LintPanel.test.tsx`（新增）

- [ ] **Step 1: graphStore 扩展**

`importWikiFiles` 加 `mode` 参数并透传；新增 `lintGraph` / `computeCommunities` action：
```ts
importWikiFiles: (filePaths: string[], mode?: IngestMode) => Promise<IngestResult>
lintGraph: () => Promise<LintReport | null>
computeCommunities: () => Promise<ComputeResult | null>
```
实现内 `window.electronAPI['wiki:ingestFiles'](graphId, filePaths, mode)`、`['wiki:lint'](graphId)`、`['wiki:computeCommunities'](graphId)`；后两者成功后 `loadGraph(graphId)` 刷新。

- [ ] **Step 2: 新建 `LintPanel.tsx`**

纯展示组件：props 接收 `issues: LintIssue[]`、`stats`、`onNavigate(nodeId)`、`onClose`、`onRecompute`。按 `kind` 分组列出，点击条目调 `onNavigate(nodeId)`。无内部 IPC 调用（数据由父组件经 graphStore 注入），便于组件测试。

- [ ] **Step 3: 画布接线**

`GraphCanvas`：新增 lint 面板状态（open/issues），`handleLint` 调 `lintGraph` 并填充；`handleImportWikiFiles` 加 LLM 开关状态，按开关传 `mode`。`CanvasOverlay`：右键菜单「导入 Wiki 页面…」旁加「LLM 提炼导入…」；工具区加「图检查（Lint）」按钮。跳转用既有节点聚焦逻辑。

- [ ] **Step 4: 组件与 store 测试**

- store：`importWikiFiles` 传 `mode:'llm'` 时以第三参调用 electronAPI（mock electronAPI）
- `LintPanel`：渲染分组、点击触发 onNavigate、特殊页不显示删除（沿用现有组件测试模式，React Testing Library）

- [ ] **Step 5: 跑渲染层测试**

Run: `npx vitest run src/renderer`
Expected: PASS。

- [ ] **Step 6: 验证门槛 + Commit**

```bash
npx tsc --noEmit && npm run lint && npm run test
git add src/renderer/
git commit -m "feat(wiki): 渲染层 — LintPanel + 导入入口 LLM 开关 + graphStore lint/compute action"
```

---

## Self-Review 记录

- **Spec 覆盖**：Louvain 纯函数（T2）、graph-compute（T3）、llm-ingest（T4）、lint（T5）、IPC（T6）、渲染层（T7）、类型（T1）— 全覆盖。
- **占位符**：Task 6 Step 1 标注「查看 registerGraphHandlers 签名决定 agentRunner 注入方式」——这是有意的，因 AgentManager 的可见性需在实现时确认；实现者须先读 `registerIpcHandlers` 如何给 mindmap IPC 注入 `sendPromptViaAgent` 再落地。其余步骤均含完整代码。
- **类型一致性**：`ComputeResult`/`LintIssue`/`IngestMode` 在 T1 定义，T3/T5/T6/T7 引用一致；`communityId` 在 T1 加到 GraphNode，T3 写回、T5 读取一致；`AgentRunner` 在 T4 定义并导出，T6 使用一致。
