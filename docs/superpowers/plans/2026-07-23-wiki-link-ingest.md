# Wiki 链接全链路 + Ingest 管线实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 wikilink 全链路（统一解析 → edges 落边 → 反向链接 → 断链检测），实现规则式 markdown 文件导入管线，修复 better-sqlite3 构建失配。

**Architecture:** main 进程新建 `WikiLinkService` 作为 wikilink 唯一权威（解析复用现有 `markdown-utils`），wiki 关系以 `edge_type='wiki-link'` 存入现有 `edges` 表；`IngestService` 编排批量文件导入并复用同一条落边路径；前端 `WikiPageEditor` 删除自有正则，通过新 IPC 通道获取结构化解析结果渲染。

**Tech Stack:** TypeScript / Electron (main + preload + renderer) / better-sqlite3 / React + Zustand / ReactMarkdown / Vitest。

**Spec:** [docs/superpowers/specs/2026-07-23-wiki-link-ingest-design.md](../specs/2026-07-23-wiki-link-ingest-design.md)
**任务跟踪:** [docs/tasks/2026-07-23-wiki-link-ingest.md](../../../tasks/2026-07-23-wiki-link-ingest.md)（每完成一个 Task 必须更新）

**关键背景（执行者必读）：**
- 现有 `src/main/wiki/markdown-utils.ts` 提供 `parseWikiMarkdown()` / `extractWikiLinks()`（已处理代码块掩码与 `[[目标|显示]]` 别名）/ `normalizeWikiTitle()` / `stringifyWikiMarkdown()`，**直接复用，不要重写**
- `WikiIndexService.resolveWikiLink(graphId, targetTitle, nodeRepo)` 已存在（`src/main/services/wiki-index-service.ts:73`），是静态方法
- 节点与边的 CRUD 在 IPC 层直接调用 `nodeRepo` / `edgeRepo`（不经 GraphService），因此落边钩子挂在 `src/main/ipc/graph.ts` 的 `node:create` / `node:createBatch` / `node:update` 处理器上
- `edges` 表外键 `source`/`target` 均 `ON DELETE CASCADE`，节点删除时 wiki-link 边自动清理
- `WikiPageEditor` 中 `wikiMeta` 是 wiki 的**外部存储**（title 同步、快速过滤），markdown 内嵌 frontmatter 是**内容载体**；保存时需同时更新两者（参考现有 `WikiIndexService.createWikiPage` 的做法）
- 测试约定：main 进程服务测试用内存 fake repo（不碰 better-sqlite3），模式参考 `src/main/services/__tests__/wiki-index-service.test.ts`；renderer store 测试用 `vi.stubGlobal('window', { electronAPI: {...} })`，模式参考 `src/renderer/store/__tests__/graphStore.test.ts`
- better-sqlite3 测试因本地 Node 版本失配失败时，先执行 Task 1 的 rebuild

---

### Task 1: 修复 better-sqlite3 构建失配

**Files:**
- 无代码变更（环境修复）

- [ ] **Step 1: 重新编译原生模块**

Run: `npm rebuild better-sqlite3`
Expected: 输出 `rebuilt dependencies successfully` 或同类成功信息，无错误

- [ ] **Step 2: 全量测试确认基线恢复**

Run: `npm run test 2>&1 | tail -5`
Expected: `Test Files  167 passed` 附近，failed 为 0

- [ ] **Step 3: 更新任务跟踪文档**

编辑 `docs/tasks/2026-07-23-wiki-link-ingest.md`：勾选 T1，在「决策记录」追加一行 `- 2026-07-23：T1 完成，better-sqlite3 rebuild 后测试基线恢复（167 文件全绿）`。

- [ ] **Step 4: Commit**

```bash
git add docs/tasks/2026-07-23-wiki-link-ingest.md
git commit -m "chore(wiki): T1 完成 — better-sqlite3 rebuild 修复测试环境，任务文档更新"
```

---

### Task 2: EdgeType 增加 wiki-link + WikiLinkService + IPC 落边钩子

**Files:**
- Modify: `src/shared/types/graph.ts:52`（EdgeType 联合类型）与 `:367`（EDGE_TYPE_VALUES）
- Create: `src/main/services/wiki-link-service.ts`
- Test: `src/main/services/__tests__/wiki-link-service.test.ts`
- Modify: `src/main/ipc/graph.ts`（node:create / node:createBatch / node:update 钩子 + edge:create 拒绝 wiki-link + wiki:resolveLink 收编）
- Test: `src/main/ipc/__tests__/graph.test.ts`（扩充）

- [ ] **Step 1: 扩展 EdgeType（先于服务，服务依赖该类型）**

`src/shared/types/graph.ts` 第 52 行改为：

```typescript
export type EdgeType = 'default' | 'success' | 'failure' | 'condition' | 'business-flow' | 'semantic' | 'dependency' | 'co-change' | 'wiki-link'
```

第 367 行改为：

```typescript
export const EDGE_TYPE_VALUES = ['default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link'] as const
```

- [ ] **Step 2: 编写 WikiLinkService 失败测试**

创建 `src/main/services/__tests__/wiki-link-service.test.ts`：

```typescript
/**
 * WikiLinkService 测试
 * 使用内存 fake repo（不依赖 better-sqlite3），模式同 wiki-index-service.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { GraphEdge, GraphNode } from '@shared/types'
import { WikiLinkService, type WikiNodeRepo, type WikiEdgeRepo } from '../wiki-link-service'
import { generateId } from '../../shared/env'

type CreateNodeInput = Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>

function createFakeRepos() {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const nodeRepo: WikiNodeRepo = {
    findById: (id) => nodes.find((n) => n.id === id) ?? null,
    listByGraph: (graphId) => nodes.filter((n) => n.graphId === graphId),
  }
  const edgeRepo: WikiEdgeRepo = {
    create(data) {
      const edge: GraphEdge = { ...data, id: generateId('edge') }
      edges.push(edge)
      return edge
    },
    delete(id) {
      const idx = edges.findIndex((e) => e.id === id)
      if (idx !== -1) edges.splice(idx, 1)
    },
    listByGraph: (graphId) => edges.filter((e) => e.graphId === graphId),
  }

  function addWikiPage(title: string, wikiContent: string, graphId = 'g1'): GraphNode {
    const now = new Date().toISOString()
    const data: CreateNodeInput = {
      type: 'wiki-page', status: 'draft', title, graphId, graphType: 'online',
      position: { x: 0, y: 0 }, wikiContent,
    }
    const node: GraphNode = { ...data, id: generateId('node'), createdAt: now, updatedAt: now }
    nodes.push(node)
    return node
  }

  return { nodeRepo, edgeRepo, nodes, edges, addWikiPage }
}

describe('WikiLinkService.syncNodeLinks', () => {
  let f: ReturnType<typeof createFakeRepos>
  beforeEach(() => { f = createFakeRepos() })

  it('为已解析的 wikilink 创建 wiki-link 边，悬空链接不落库', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '# B\n\n参见 [[页面A]] 和 [[不存在页]]')

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.added).toHaveLength(1)
    expect(result.added[0].edgeType).toBe('wiki-link')
    expect(result.added[0].source).toBe(b.id)
    expect(result.dangling).toEqual(['不存在页'])
    expect(f.edges).toHaveLength(1)
  })

  it('重复同步幂等：内容不变时不增删边', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    const second = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(second.added).toHaveLength(0)
    expect(second.removed).toHaveLength(0)
    expect(f.edges).toHaveLength(1)
  })

  it('内容更新后 diff 增删边', () => {
    const a = f.addWikiPage('页面A', '# A')
    const c = f.addWikiPage('页面C', '# C')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    // 模拟 node:update：先改内容再同步
    b.wikiContent = '[[页面C]]'
    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(1)
    expect(result.added[0].target).toBe(c.id)
    expect(f.edges).toHaveLength(1)
    expect(f.edges[0].target).toBe(c.id)
    expect(f.edges[0].target).not.toBe(a.id)
  })

  it('支持 [[目标|显示文本]] 别名与标题归一化', () => {
    f.addWikiPage('Graph Log', '# Log')
    const b = f.addWikiPage('页面B', '见 [[graph　log|日志页]]')  // 全角空格+大小写差异

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.added).toHaveLength(1)
    expect(result.dangling).toEqual([])
  })

  it('跳过代码块内的 [[link]]', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '```\n[[页面A]]\n```\n正文无链接')

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.added).toHaveLength(0)
    expect(result.dangling).toEqual([])
  })

  it('自链接创建自环边，非 wiki-page 节点返回空结果', () => {
    const b = f.addWikiPage('页面B', '自引 [[页面B]]')
    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)
    expect(result.added).toHaveLength(1)
    expect(result.added[0].target).toBe(b.id)

    const feature: GraphNode = {
      id: 'feat-1', type: 'feature', status: 'draft', title: 'F',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      createdAt: '', updatedAt: '',
    }
    f.nodes.push(feature)
    const r2 = WikiLinkService.syncNodeLinks('feat-1', f.nodeRepo, f.edgeRepo)
    expect(r2).toEqual({ added: [], removed: [], dangling: [] })
  })
})

describe('WikiLinkService.parseContent / getBacklinks / findDanglingLinks', () => {
  let f: ReturnType<typeof createFakeRepos>
  beforeEach(() => { f = createFakeRepos() })

  it('parseContent 返回 frontmatter、title 与带 resolved 标记的链接', () => {
    const a = f.addWikiPage('页面A', '# A')
    const parsed = WikiLinkService.parseContent(
      'g1',
      '---\ntags:\n  - x\n---\n# 标题\n\n[[页面A|别名]] [[缺失]]',
      f.nodeRepo,
    )

    expect(parsed.frontmatter).toEqual({ tags: ['x'] })
    expect(parsed.title).toBe('标题')
    expect(parsed.links).toHaveLength(2)
    expect(parsed.links[0]).toMatchObject({ targetTitle: '页面A', displayText: '别名', resolved: true, nodeId: a.id })
    expect(parsed.links[1]).toMatchObject({ targetTitle: '缺失', resolved: false })
  })

  it('getBacklinks 返回指向目标节点的源页面', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    const a = f.nodes.find((n) => n.title === '页面A')!
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    const backlinks = WikiLinkService.getBacklinks(a.id, f.nodeRepo, f.edgeRepo)

    expect(backlinks).toHaveLength(1)
    expect(backlinks[0].id).toBe(b.id)
  })

  it('findDanglingLinks 汇总全图悬空链接', () => {
    f.addWikiPage('页面A', '[[缺失1]]')
    f.addWikiPage('页面B', '[[缺失2]] [[缺失1]]')

    const dangling = WikiLinkService.findDanglingLinks('g1', f.nodeRepo)

    expect(dangling).toHaveLength(3)
    expect(dangling.map((d) => d.targetTitle).sort()).toEqual(['缺失1', '缺失1', '缺失2'])
    expect(dangling[0]).toHaveProperty('fromNodeId')
    expect(dangling[0]).toHaveProperty('fromTitle')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/main/services/__tests__/wiki-link-service.test.ts`
Expected: FAIL，报 `Cannot find module '../wiki-link-service'` 或同类导入错误

- [ ] **Step 4: 实现 WikiLinkService**

创建 `src/main/services/wiki-link-service.ts`：

```typescript
/**
 * Wiki 链接服务
 *
 * wikilink 的唯一权威：解析（复用 markdown-utils）、按标题解析目标、
 * 将已解析链接持久化为 edges 表 edge_type='wiki-link' 的边、反向链接查询、
 * 全图断链扫描。悬空链接不入库，由 parseContent 实时标记。
 */

import type { GraphEdge, GraphNode } from '@shared/types'
import { extractWikiLinks, normalizeWikiTitle, parseWikiMarkdown } from '../wiki/markdown-utils'
import { WikiIndexService } from './wiki-index-service'

export interface WikiNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
}

export interface WikiEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

export interface SyncLinksResult {
  added: GraphEdge[]
  removed: GraphEdge[]
  dangling: string[]
}

export interface WikiLinkResolution {
  targetTitle: string
  displayText?: string
  resolved: boolean
  nodeId?: string
}

export interface ParsedWikiContent {
  frontmatter: Record<string, unknown>
  title?: string
  links: WikiLinkResolution[]
}

export interface DanglingLink {
  fromNodeId: string
  fromTitle: string
  targetTitle: string
}

export class WikiLinkService {
  /**
   * 同步某个 wiki-page 节点的 wiki-link 出边。
   * 解析 wikiContent → 提取 wikilinks → 按标题解析目标 →
   * 与该节点现有 wiki-link 出边 diff → 增删。
   * 非 wiki-page 节点或不存在的节点返回空结果。
   */
  static syncNodeLinks(nodeId: string, nodeRepo: WikiNodeRepo, edgeRepo: WikiEdgeRepo): SyncLinksResult {
    const empty: SyncLinksResult = { added: [], removed: [], dangling: [] }
    const node = nodeRepo.findById(nodeId)
    if (!node || node.type !== 'wiki-page') return empty

    const targetIds = new Set<string>()
    const danglingTitles = new Set<string>()
    if (node.wikiContent) {
      for (const link of extractWikiLinks(node.wikiContent)) {
        const resolvedId = WikiIndexService.resolveWikiLink(node.graphId, link.targetTitle, nodeRepo)
        if (resolvedId) targetIds.add(resolvedId)
        else danglingTitles.add(normalizeWikiTitle(link.targetTitle))
      }
    }

    const existing = edgeRepo
      .listByGraph(node.graphId)
      .filter((e) => e.edgeType === 'wiki-link' && e.source === nodeId)
    const existingTargets = new Map(existing.map((e) => [e.target, e]))

    const added: GraphEdge[] = []
    for (const targetId of targetIds) {
      if (!existingTargets.has(targetId)) {
        added.push(edgeRepo.create({ source: nodeId, target: targetId, edgeType: 'wiki-link', graphId: node.graphId }))
      }
    }
    const removed: GraphEdge[] = []
    for (const [targetId, edge] of existingTargets) {
      if (!targetIds.has(targetId)) {
        edgeRepo.delete(edge.id)
        removed.push(edge)
      }
    }

    return { added, removed, dangling: [...danglingTitles] }
  }

  /** 实时解析（不落库），供前端渲染 wikilink 与 frontmatter */
  static parseContent(graphId: string, content: string, nodeRepo: WikiNodeRepo): ParsedWikiContent {
    const parsed = parseWikiMarkdown(content)
    const links: WikiLinkResolution[] = []
    const seen = new Set<string>()
    for (const link of extractWikiLinks(content)) {
      const key = normalizeWikiTitle(link.targetTitle).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const nodeId = WikiIndexService.resolveWikiLink(graphId, link.targetTitle, nodeRepo)
      links.push({
        targetTitle: link.targetTitle,
        ...(link.displayText ? { displayText: link.displayText } : {}),
        resolved: nodeId !== null,
        ...(nodeId ? { nodeId } : {}),
      })
    }
    return { frontmatter: parsed.frontmatter, title: parsed.title, links }
  }

  /** 反向链接：指向目标节点的 wiki-link 源页面 */
  static getBacklinks(nodeId: string, nodeRepo: WikiNodeRepo, edgeRepo: WikiEdgeRepo): GraphNode[] {
    const node = nodeRepo.findById(nodeId)
    if (!node) return []
    const sourceIds = edgeRepo
      .listByGraph(node.graphId)
      .filter((e) => e.edgeType === 'wiki-link' && e.target === nodeId)
      .map((e) => e.source)
    return [...new Set(sourceIds)]
      .map((id) => nodeRepo.findById(id))
      .filter((n): n is GraphNode => n !== null)
  }

  /** 全图断链扫描（Graph Lint 基础） */
  static findDanglingLinks(graphId: string, nodeRepo: WikiNodeRepo): DanglingLink[] {
    const result: DanglingLink[] = []
    for (const node of nodeRepo.listByGraph(graphId)) {
      if (node.type !== 'wiki-page' || !node.wikiContent) continue
      for (const link of extractWikiLinks(node.wikiContent)) {
        if (WikiIndexService.resolveWikiLink(graphId, link.targetTitle, nodeRepo) === null) {
          result.push({ fromNodeId: node.id, fromTitle: node.title, targetTitle: normalizeWikiTitle(link.targetTitle) })
        }
      }
    }
    return result
  }
}
```

**注意 1**：`WikiIndexService.resolveWikiLink` 当前声明为 `async`。为支持上述同步调用，将其签名改为同步（去掉 `async`，返回类型 `Promise<string | null>` → `string | null`）：`src/main/services/wiki-index-service.ts:73` 的方法体本就是同步的，仅改签名；其唯一调用方 `src/main/ipc/graph.ts:278` 的 `return WikiIndexService.resolveWikiLink(...)` 位于 async handler 中，同步返回值会被自动包装，无需改动。`src/main/services/__tests__/wiki-index-service.test.ts` 中对它的调用带 `await`，`await` 一个非 Promise 值是合法的，测试无需改动。

**注意 2**：`markdown-utils.ts` 的 `parseWikiMarkdown` 在 frontmatter YAML 非法时会抛 `WIKI_PARSE_ERROR`。本服务各方法按设计不捕获该错误（编辑中途的中间状态应静默失败）：IPC 层的 `wiki:parseContent` 会让错误沿 IPC 返回给前端，前端 catch 后降级；`syncNodeLinks` 内部不调用 `parseWikiMarkdown`（只用不抛错的 `extractWikiLinks`），因此落边路径不受影响。

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/main/services/__tests__/wiki-link-service.test.ts src/main/services/__tests__/wiki-index-service.test.ts`
Expected: 两个文件全部 PASS

- [ ] **Step 6: IPC 落边钩子 + edge:create 守卫 + wiki:resolveLink 收编**

`src/main/ipc/graph.ts` 修改：

1) 顶部 import 区添加：

```typescript
import { WikiLinkService } from '../services/wiki-link-service'
```

2) 在 `registerGraphHandlers` 函数体内、`const bugRepo = ...` 之后添加：

```typescript
  /** wikiContent 变更后同步 wiki-link 边（失败仅记录，不阻断节点操作） */
  function syncWikiLinks(nodeId: string): void {
    try {
      WikiLinkService.syncNodeLinks(nodeId, nodeRepo, edgeRepo)
    } catch (err) {
      console.error('[wiki] syncNodeLinks failed for', nodeId, err)
    }
  }
```

3) `node:create` 处理器（第 169-172 行）改为：

```typescript
  typedHandle('node:create', async (_, data) => {
    validateNodeCreate(data)
    const node = nodeRepo.create(data as Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>)
    if (node.type === 'wiki-page' && node.wikiContent) syncWikiLinks(node.id)
    return node
  })
```

4) `node:createBatch` 处理器（第 174-182 行）`return` 语句改为：

```typescript
    const created = nodeRepo.createBatch(nodesData as Array<Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>>)
    for (const node of created) {
      if (node.type === 'wiki-page' && node.wikiContent) syncWikiLinks(node.id)
    }
    return created
```

5) `node:update` 处理器中 `const node = await nodeRepo.update(id, data)`（第 203 行）之后插入：

```typescript
    if (data.wikiContent !== undefined) syncWikiLinks(id)
```

6) `edge:create` 处理器（第 218-220 行）改为（wiki-link 边由 syncNodeLinks 全权管理，禁止手工创建）：

```typescript
  typedHandle('edge:create', async (_, data) => {
    if ((data as GraphEdge).edgeType === 'wiki-link') {
      throw new IpcError('wiki-link edges are managed by WikiLinkService and cannot be created manually', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    return edgeRepo.create(data)
  })
```

   同时在 import 的 `@shared/types` 类型列表中加入 `GraphEdge`。

7) `wiki:resolveLink` 处理器（第 275-279 行）改为（行为不变，实现收编到 WikiLinkService 依赖的同一解析路径）：

```typescript
  typedHandle('wiki:resolveLink', async (_, graphId: string, targetTitle: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    ensureString('targetTitle', targetTitle, MAX_TITLE_LEN)
    return WikiIndexService.resolveWikiLink(graphId, targetTitle, nodeRepo)
  })
```

   （签名上由 Promise 变为直接返回 string | null，handler 为 async 自动包装。）

- [ ] **Step 7: 扩充 IPC 测试**

`src/main/ipc/__tests__/graph.test.ts` 在 `describe('node:update')` 块内追加：

```typescript
    it('accepts valid wikiContent update and triggers no error from sync', async () => {
      stmtMock.get.mockReturnValueOnce({
        id: 'node-1', type: 'wiki-page', status: 'draft', title: 'Wiki', description: null, acceptance_criteria: null,
        graph_id: 'graph-1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
        content: null, community_summary: null, community_level: null,
        wiki_content: '[[Some Page]]', wiki_meta: null,
        owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      })
      await expect(handlers['node:update']({}, 'node-1', { wikiContent: '[[Some Page]]' })).resolves.not.toThrow()
    })
```

并在文件末尾追加新 describe 块：

```typescript
  describe('edge:create wiki-link guard', () => {
    it('rejects manual wiki-link edge creation', async () => {
      await expect(handlers['edge:create']({}, {
        source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'wiki-link',
      })).rejects.toThrow(IpcError)
    })

    it('allows business edge creation', async () => {
      await expect(handlers['edge:create']({}, {
        source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'default',
      })).resolves.not.toThrow()
    })
  })

  describe('wiki:resolveLink', () => {
    it('rejects empty targetTitle', async () => {
      await expect(handlers['wiki:resolveLink']({}, 'graph-1', '')).rejects.toThrow(IpcError)
    })
  })
```

- [ ] **Step 8: 运行测试与类型检查**

Run: `npx vitest run src/main/ipc/__tests__/graph.test.ts src/main/services/__tests__/ && npx tsc --noEmit`
Expected: 全部 PASS；tsc 零错误

- [ ] **Step 9: 更新任务跟踪文档并 Commit**

`docs/tasks/2026-07-23-wiki-link-ingest.md`：勾选 T2，决策记录追加完成行。

```bash
git add src/shared/types/graph.ts src/main/services/wiki-link-service.ts src/main/services/__tests__/wiki-link-service.test.ts src/main/services/wiki-index-service.ts src/main/ipc/graph.ts src/main/ipc/__tests__/graph.test.ts docs/tasks/2026-07-23-wiki-link-ingest.md
git commit -m "feat(wiki): EdgeType 增加 wiki-link + WikiLinkService + IPC 落边钩子

- EdgeType/EDGE_TYPE_VALUES 新增 wiki-link
- 新增 WikiLinkService：syncNodeLinks diff 落边、parseContent、getBacklinks、findDanglingLinks
- WikiIndexService.resolveWikiLink 改为同步签名
- node:create/createBatch/update 在 wikiContent 变更后自动同步 wiki-link 边
- edge:create 拒绝手工创建 wiki-link 边
- 测试：wiki-link-service 10 例 + IPC 扩充 4 例"
```

---

### Task 3: IPC 新通道 + preload + 前端 WikiPageEditor 重写

**Files:**
- Modify: `src/shared/types/wiki.ts`（新增 ParsedWikiContent / DanglingLink / IngestResult 类型）
- Modify: `src/shared/types/ipc.ts`（4 个新通道 + dialog:openFiles）
- Modify: `src/preload/index.ts`（暴露新通道）
- Modify: `src/main/ipc/graph.ts`（注册 wiki:parseContent / wiki:getBacklinks / wiki:findDangling）
- Modify: `src/main/ipc/dialog.ts`（dialog:openFiles）
- Test: `src/main/ipc/__tests__/graph.test.ts`（扩充）
- Create: `src/renderer/lib/wiki-render.ts`
- Test: `src/renderer/lib/__tests__/wiki-render.test.ts`
- Modify: `src/renderer/components/wiki/WikiPageEditor.tsx`（重写）
- Modify: `src/renderer/panels/NodeEditor.tsx`（接线新 props + 特殊页删除保护）
- Modify: `src/renderer/canvas/NodeContextMenu.tsx`（特殊页删除保护）

- [ ] **Step 1: 共享类型**

`src/shared/types/wiki.ts` 在文件末尾追加：

```typescript
/** 带解析状态的 wikilink（parseContent 返回） */
export interface WikiLinkResolution {
  targetTitle: string
  displayText?: string
  resolved: boolean
  nodeId?: string
}

/** wiki:parseContent 返回的结构化解析结果 */
export interface ParsedWikiContent {
  frontmatter: Record<string, unknown>
  title?: string
  links: WikiLinkResolution[]
}

/** 悬空链接（断链）记录 */
export interface DanglingLink {
  fromNodeId: string
  fromTitle: string
  targetTitle: string
}

/** 单文件导入失败记录 */
export interface IngestFailure {
  file: string
  error: string
}

/** wiki:ingestFiles 返回的导入结果 */
export interface IngestResult {
  created: { id: string; title: string }[]
  updated: { id: string; title: string }[]
  failed: IngestFailure[]
}
```

`src/main/services/wiki-link-service.ts` 中的 `WikiLinkResolution` / `ParsedWikiContent` / `DanglingLink` 接口删除，改为从共享类型导入并 re-export（保持 Task 2 已写的测试导入不变）：

```typescript
import type { DanglingLink, ParsedWikiContent, WikiLinkResolution } from '@shared/types/wiki'
export type { DanglingLink, ParsedWikiContent, WikiLinkResolution } from '@shared/types/wiki'
```

- [ ] **Step 2: IpcApi 通道声明**

`src/shared/types/ipc.ts`：import 区加入 `import type { ParsedWikiContent, DanglingLink, IngestResult } from './wiki'`。`'wiki:resolveLink'` 一行（第 61 行附近）替换为：

```typescript
  // Wiki 操作
  'wiki:resolveLink': (graphId: string, targetTitle: string) => Promise<string | null>
  'wiki:parseContent': (graphId: string, content: string) => Promise<ParsedWikiContent>
  'wiki:getBacklinks': (nodeId: string) => Promise<{ id: string; title: string }[]>
  'wiki:findDangling': (graphId: string) => Promise<DanglingLink[]>
  'wiki:ingestFiles': (graphId: string, filePaths: string[]) => Promise<IngestResult>
```

在 `dialog:openDirectory` 通道声明后追加：

```typescript
  'dialog:openFiles': (options?: { extensions?: string[] }) => Promise<string[]>
```

- [ ] **Step 3: preload 暴露**

`src/preload/index.ts` 的 `exposedChannels` 数组中 `'snapshot:delete',` 之后追加：

```typescript
  // Wiki operations
  'wiki:resolveLink',
  'wiki:parseContent',
  'wiki:getBacklinks',
  'wiki:findDangling',
  'wiki:ingestFiles',
```

并确认 `'dialog:openDirectory'` 所在位置后追加 `'dialog:openFiles',`。

- [ ] **Step 4: main 进程注册新通道（先写失败测试）**

`src/main/ipc/__tests__/graph.test.ts` 末尾追加：

```typescript
  describe('wiki:parseContent', () => {
    it('rejects non-string content', async () => {
      await expect(handlers['wiki:parseContent']({}, 'graph-1', 123)).rejects.toThrow(IpcError)
    })

    it('rejects oversized content', async () => {
      await expect(handlers['wiki:parseContent']({}, 'graph-1', 'x'.repeat(512 * 1024 + 1))).rejects.toThrow(IpcError)
    })

    it('returns parsed structure for valid input', async () => {
      const result = await handlers['wiki:parseContent']({}, 'graph-1', '# T\n\n[[Missing]]') as { links: unknown[]; frontmatter: Record<string, unknown> }
      expect(result.links).toHaveLength(1)
      expect(result.frontmatter).toEqual({})
    })
  })

  describe('wiki:getBacklinks', () => {
    it('rejects empty nodeId', async () => {
      await expect(handlers['wiki:getBacklinks']({}, '')).rejects.toThrow(IpcError)
    })
  })

  describe('wiki:findDangling', () => {
    it('rejects empty graphId', async () => {
      await expect(handlers['wiki:findDangling']({}, '')).rejects.toThrow(IpcError)
    })
  })
```

Run: `npx vitest run src/main/ipc/__tests__/graph.test.ts`
Expected: FAIL（`handlers['wiki:parseContent']` 为 undefined）

- [ ] **Step 5: main 进程实现新通道**

`src/main/ipc/graph.ts` 在 `wiki:resolveLink` 处理器后追加：

```typescript
  const MAX_WIKI_CONTENT_LEN = 512 * 1024

  typedHandle('wiki:parseContent', async (_, graphId: string, content: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    ensureString('content', content, MAX_WIKI_CONTENT_LEN)
    return WikiLinkService.parseContent(graphId, content, nodeRepo)
  })

  typedHandle('wiki:getBacklinks', async (_, nodeId: string) => {
    ensureString('nodeId', nodeId, MAX_ID_LEN)
    const nodes = WikiLinkService.getBacklinks(nodeId, nodeRepo, edgeRepo)
    return nodes.map((n) => ({ id: n.id, title: n.title }))
  })

  typedHandle('wiki:findDangling', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    return WikiLinkService.findDanglingLinks(graphId, nodeRepo)
  })
```

`src/main/ipc/dialog.ts` 在 `dialog:openDirectory` 后追加：

```typescript
  typedHandle('dialog:openFiles', async (_, options?: { extensions?: string[] }) => {
    const extensions = options?.extensions ?? ['md', 'markdown', 'txt']
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择要导入的文件',
      filters: [{ name: 'Documents', extensions }],
    })
    if (result.canceled) return []
    return result.filePaths
  })
```

Run: `npx vitest run src/main/ipc/__tests__/graph.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 零错误

- [ ] **Step 6: 前端渲染纯函数（TDD）**

创建 `src/renderer/lib/__tests__/wiki-render.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { parseLinkTarget, splitWikiLinks, formatMetaValue, type WikiLinkResolution } from '../wiki-render'

const resolved = (targetTitle: string, displayText?: string): WikiLinkResolution => ({
  targetTitle, displayText, resolved: true, nodeId: 'node-x',
})

describe('splitWikiLinks', () => {
  it('按 wikilink 切分文本', () => {
    const segs = splitWikiLinks('前 [[页面A|别名]] 中 [[缺失]] 后', [resolved('页面A', '别名')])
    expect(segs).toEqual([
      { kind: 'text', text: '前 ' },
      { kind: 'link', raw: '[[页面A|别名]]', targetTitle: '页面A', displayText: '别名', resolved: true, nodeId: 'node-x' },
      { kind: 'text', text: ' 中 ' },
      { kind: 'link', raw: '[[缺失]]', targetTitle: '缺失', displayText: undefined, resolved: false, nodeId: undefined },
      { kind: 'text', text: ' 后' },
    ])
  })

  it('无链接时原样返回单段', () => {
    expect(splitWikiLinks('纯文本', [])).toEqual([{ kind: 'text', text: '纯文本' }])
  })
})

describe('parseLinkTarget', () => {
  it('解析别名语法', () => {
    expect(parseLinkTarget('页面A|别名')).toEqual({ targetTitle: '页面A', displayText: '别名' })
  })

  it('无别名时 displayText 为 undefined', () => {
    expect(parseLinkTarget('页面A')).toEqual({ targetTitle: '页面A', displayText: undefined })
  })

  it('目标取第一个竖线之前（额外竖线归入显示文本）', () => {
    expect(parseLinkTarget('页面A|别|名')).toEqual({ targetTitle: '页面A', displayText: '别|名' })
  })
})

describe('formatMetaValue', () => {
  it('字符串原样', () => expect(formatMetaValue('abc')).toBe('abc'))
  it('数组逗号连接', () => expect(formatMetaValue(['a', 'b'])).toBe('a, b'))
  it('对象 JSON', () => expect(formatMetaValue({ a: 1 })).toBe('{"a":1}'))
  it('布尔转字符串', () => expect(formatMetaValue(true)).toBe('true'))
})
```

Run: `npx vitest run src/renderer/lib/__tests__/wiki-render.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 7: 实现 wiki-render.ts**

创建 `src/renderer/lib/wiki-render.ts`：

```typescript
/**
 * Wiki 渲染纯函数：把 markdown 文本中的 [[wikilink]] 切分为渲染片段。
 * 解析状态（resolved / nodeId）来自后端 wiki:parseContent，前端不做标题匹配。
 */

export interface WikiLinkResolution {
  targetTitle: string
  displayText?: string
  resolved: boolean
  nodeId?: string
}

export type WikiRenderSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; raw: string; targetTitle: string; displayText?: string; resolved: boolean; nodeId?: string }

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

export function parseLinkTarget(inner: string): { targetTitle: string; displayText?: string } {
  const pipeIdx = inner.indexOf('|')
  if (pipeIdx === -1) return { targetTitle: inner.trim() }
  return {
    targetTitle: inner.slice(0, pipeIdx).trim(),
    displayText: inner.slice(pipeIdx + 1).trim() || undefined,
  }
}

export function splitWikiLinks(text: string, links: WikiLinkResolution[]): WikiRenderSegment[] {
  const byKey = new Map(links.map((l) => [l.targetTitle.trim().toLowerCase(), l]))
  const segments: WikiRenderSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
    }
    const { targetTitle, displayText } = parseLinkTarget(match[1])
    const resolution = byKey.get(targetTitle.toLowerCase())
    segments.push({
      kind: 'link',
      raw: match[0],
      targetTitle,
      displayText,
      resolved: resolution?.resolved ?? false,
      nodeId: resolution?.nodeId,
    })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) })
  }
  if (segments.length === 0) segments.push({ kind: 'text', text })
  return segments
}

export function formatMetaValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}
```

Run: `npx vitest run src/renderer/lib/__tests__/wiki-render.test.ts`
Expected: PASS

- [ ] **Step 8: 重写 WikiPageEditor**

整体替换 `src/renderer/components/wiki/WikiPageEditor.tsx`：

```tsx
/**
 * Wiki 页面编辑器
 * 解析规则统一在后端（wiki:parseContent），前端只负责渲染：
 * - Markdown 页签：原始编辑，失焦保存（同时落 markdown 与 wikiMeta.frontmatter）
 * - 预览页签：wikilink 内联渲染，已解析可跳转，悬空可一键创建
 * - Backlinks 页签：反向链接列表
 * - Meta 页签：后端解析的 frontmatter 只读展示
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { BookOpen, PenLine, Eye, Settings2, Link2, FileText, Plus, CornerDownLeft } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from '@/components/ui/dialog'
import { useGraphStore } from '@/store/graphStore'
import { splitWikiLinks, formatMetaValue, type WikiLinkResolution, type WikiRenderSegment } from '@/lib/wiki-render'
import { cn } from '@/lib/utils'

interface WikiPageEditorProps {
  nodeId: string
  graphId: string
  wikiContent: string | undefined
  wikiMeta: Record<string, unknown> | undefined
  onUpdate: (data: { wikiContent?: string; wikiMeta?: Record<string, unknown> }) => void
  onNavigate?: (nodeId: string) => void
}

const PARSE_DEBOUNCE_MS = 500

export function WikiPageEditor({
  nodeId,
  graphId,
  wikiContent,
  wikiMeta,
  onUpdate,
  onNavigate,
}: WikiPageEditorProps) {
  const [activeTab, setActiveTab] = useState('content')
  const [draft, setDraft] = useState(wikiContent ?? '')
  const [links, setLinks] = useState<WikiLinkResolution[]>([])
  const [backlinks, setBacklinks] = useState<{ id: string; title: string }[]>([])
  const [createTarget, setCreateTarget] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createNode = useGraphStore((s) => s.createNode)

  // 外部内容变化（如 Agent 更新）时同步草稿
  useEffect(() => {
    setDraft(wikiContent ?? '')
  }, [wikiContent])

  // 防抖解析（仅更新链接解析状态，不落库）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      window.electronAPI['wiki:parseContent'](graphId, draft)
        .then((r) => setLinks(r.links))
        .catch(() => setLinks([]))
    }, PARSE_DEBOUNCE_MS)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [draft, graphId])

  // Backlinks 页签激活时拉取
  useEffect(() => {
    if (activeTab !== 'backlinks') return
    window.electronAPI['wiki:getBacklinks'](nodeId)
      .then(setBacklinks)
      .catch(() => setBacklinks([]))
  }, [activeTab, nodeId])

  const handleBlur = useCallback(() => {
    if (draft === (wikiContent ?? '')) return
    window.electronAPI['wiki:parseContent'](graphId, draft)
      .then((parsed) => {
        onUpdate({
          wikiContent: draft,
          wikiMeta: { ...(wikiMeta ?? {}), frontmatter: parsed.frontmatter },
        })
      })
      .catch(() => {
        // frontmatter YAML 错误时仍保存内容，wikiMeta 保持不变
        onUpdate({ wikiContent: draft })
      })
  }, [draft, wikiContent, wikiMeta, graphId, onUpdate])

  const handleCreatePage = useCallback(async () => {
    if (!createTarget) return
    const graphType = useGraphStore.getState().nodes.find((n) => n.id === nodeId)?.graphType ?? 'online'
    const node = await createNode({
      type: 'wiki-page',
      status: 'draft',
      title: createTarget,
      graphId,
      graphType,
      position: { x: 0, y: 0 },
      acceptanceCriteria: [],
      wikiContent: `# ${createTarget}\n\n`,
    })
    setCreateTarget(null)
    onNavigate?.(node.id)
  }, [createTarget, createNode, graphId, nodeId, onNavigate])

  const frontmatter = (wikiMeta?.frontmatter ?? {}) as Record<string, unknown>
  const segments = splitWikiLinks(draft, links)
  const hasLinks = segments.some((s) => s.kind === 'link')

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
        <BookOpen className="w-3.5 h-3.5" />
        <span>Wiki 页面</span>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4 h-8">
          <TabsTrigger value="content" className="text-xs gap-1">
            <PenLine className="w-3 h-3" />
            Markdown
          </TabsTrigger>
          <TabsTrigger value="preview" className="text-xs gap-1">
            <Eye className="w-3 h-3" />
            预览
          </TabsTrigger>
          <TabsTrigger value="backlinks" className="text-xs gap-1">
            <CornerDownLeft className="w-3 h-3" />
            反向链接
          </TabsTrigger>
          <TabsTrigger value="meta" className="text-xs gap-1">
            <Settings2 className="w-3 h-3" />
            Meta
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleBlur}
            placeholder="输入 Markdown 内容... 使用 [[页面标题]] 创建 wikilink"
            className="w-full px-2 py-1.5 text-sm border rounded-md bg-background font-mono resize-y min-h-[180px]"
            spellCheck={false}
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            失焦自动保存。[[页面标题]] 或 [[页面标题|显示文本]] 链接到同图 Wiki 页面
          </p>
        </TabsContent>

        <TabsContent value="preview" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[180px] max-h-[360px] overflow-y-auto">
            {!draft ? (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <FileText className="w-3 h-3" />
                暂无内容，请在 Markdown 页签中编辑
              </div>
            ) : (
              <>
                {/* 结构化预览：GFM 渲染，[[link]] 以代码样式占位展示 */}
                <div className="prose prose-sm dark:prose-invert max-w-none [&_code]:text-xs">
                  <ReactMarkdownSkipLinks content={draft} />
                </div>
                {/* 链接区：wikilink 内联交互（跳转 / 创建） */}
                {hasLinks && (
                  <div className="mt-3 pt-2 border-t space-y-1" data-testid="wiki-links">
                    <p className="text-[10px] text-muted-foreground">页面链接</p>
                    <WikiLinkList segments={segments} onNavigate={onNavigate} onCreate={setCreateTarget} />
                  </div>
                )}
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="backlinks" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[120px]">
            {backlinks.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无其他页面链接到本页</p>
            ) : (
              <ul className="space-y-1">
                {backlinks.map((b) => (
                  <li key={b.id}>
                    <button
                      onClick={() => onNavigate?.(b.id)}
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <Link2 className="w-3 h-3" />
                      {b.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="meta" className="mt-2">
          <div className="border rounded-md bg-background p-3 min-h-[120px]">
            {Object.keys(frontmatter).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                无 frontmatter。在 Markdown 顶部以 --- 包裹 YAML 即可添加，保存后在此查看。
              </p>
            ) : (
              <dl className="space-y-1">
                {Object.entries(frontmatter).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-xs">
                    <dt className="font-medium text-muted-foreground shrink-0 w-24 truncate">{key}</dt>
                    <dd className="flex-1 break-all">{formatMetaValue(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* 悬空链接 → 创建页面确认 */}
      <Dialog open={createTarget !== null} onOpenChange={(open) => { if (!open) setCreateTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">创建 Wiki 页面「{createTarget}」？</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            该链接指向的页面尚不存在。创建后链接将自动解析。
          </p>
          <DialogFooter>
            <DialogClose className="px-3 py-1.5 text-xs border rounded-md hover:bg-muted">取消</DialogClose>
            <button
              onClick={handleCreatePage}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              <Plus className="w-3 h-3" />
              创建
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * GFM 渲染：[[link]] 以行内代码样式占位（wikilink 的交互在下方链接区）。
 * 预处理把 [[...]] 包为 `[[...]]`，避免被 markdown 语法解析切碎。
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function ReactMarkdownSkipLinks({ content }: { content: string }) {
  const prepared = content.replace(/\[\[([^\]]+)\]\]/g, '`[[$1]]`')
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{prepared}</ReactMarkdown>
}

function WikiLinkList({
  segments,
  onNavigate,
  onCreate,
}: {
  segments: WikiRenderSegment[]
  onNavigate?: (nodeId: string) => void
  onCreate: (targetTitle: string) => void
}) {
  const seen = new Set<string>()
  return (
    <ul className="flex flex-wrap gap-1.5">
      {segments.filter((s) => s.kind === 'link').map((seg) => {
        if (seg.kind !== 'link') return null
        const key = seg.targetTitle.toLowerCase()
        if (seen.has(key)) return null
        seen.add(key)
        if (seg.resolved && seg.nodeId) {
          return (
            <li key={key}>
              <button
                onClick={() => onNavigate?.(seg.nodeId!)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20"
                title={`跳转到「${seg.targetTitle}」`}
              >
                <Link2 className="w-3 h-3" />
                {seg.displayText ?? seg.targetTitle}
              </button>
            </li>
          )
        }
        return (
          <li key={key}>
            <button
              onClick={() => onCreate(seg.targetTitle)}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-dashed border-muted-foreground/50 text-muted-foreground hover:text-foreground"
              title={`页面「${seg.targetTitle}」不存在，点击创建`}
            >
              <Plus className="w-3 h-3" />
              {seg.displayText ?? seg.targetTitle}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function WikiPageBadge({ nodeId, className }: { nodeId: string; className?: string }) {
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId))
  if (!node) return null
  return (
    <button
      onClick={() => useGraphStore.getState().selectNode(nodeId)}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 text-[10px] rounded bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors',
        className,
      )}
    >
      <BookOpen className="w-3 h-3" />
      {node.title}
    </button>
  )
}
```

- [ ] **Step 9: NodeEditor 接线 + 特殊页删除保护**

`src/renderer/panels/NodeEditor.tsx`：

1) WikiPageEditor 调用处（第 540-544 行）改为：

```tsx
        <WikiPageEditor
          nodeId={node.id}
          graphId={node.graphId}
          wikiContent={node.wikiContent}
          wikiMeta={node.wikiMeta}
          onUpdate={handleWikiUpdate}
          onNavigate={onNavigate}
        />
```

2) 删除按钮（`node.type !== 'project'` 条件处）改为同时排除特殊页：

```tsx
        {node.type !== 'project' && !node.wikiMeta?.specialPage && (
```

`src/renderer/canvas/NodeContextMenu.tsx`：删除菜单项渲染条件处，为特殊页隐藏删除项。找到渲染 `onDelete` 按钮的 JSX（约第 223 行），在其外层条件中加入：

```tsx
{!nodes.find((n) => n.id === nodeId)?.wikiMeta?.specialPage && (
  // ...现有删除按钮
)}
```

（`nodes` 已是该组件 props。）

- [ ] **Step 10: 全量验证**

Run: `npx tsc --noEmit && npm run lint && npx vitest run src/renderer src/main/ipc src/main/services`
Expected: tsc 零错误、lint 零警告、相关测试全部 PASS

- [ ] **Step 11: 更新任务跟踪文档并 Commit**

勾选 T3，决策记录追加完成行。

```bash
git add src/shared/types/wiki.ts src/shared/types/ipc.ts src/preload/index.ts src/main/ipc/graph.ts src/main/ipc/dialog.ts src/main/ipc/__tests__/graph.test.ts src/main/services/wiki-link-service.ts src/renderer/lib/wiki-render.ts src/renderer/lib/__tests__/wiki-render.test.ts src/renderer/components/wiki/WikiPageEditor.tsx src/renderer/panels/NodeEditor.tsx src/renderer/canvas/NodeContextMenu.tsx docs/tasks/2026-07-23-wiki-link-ingest.md
git commit -m "feat(wiki): IPC 新通道 + WikiPageEditor 重写

- 新增 wiki:parseContent / wiki:getBacklinks / wiki:findDangling / dialog:openFiles
- 共享类型 ParsedWikiContent / DanglingLink / IngestResult 移至 @shared/types/wiki
- WikiPageEditor 删除手写正则与 YAML 解析器，统一走后端解析
- 预览页签 wikilink 内联渲染：已解析可跳转、悬空可一键创建
- 新增 Backlinks 页签；Meta 页签改为只读结构化展示
- 特殊页（specialPage）禁止删除"
```

---

### Task 4: Ingest 管线 + graphStore 过滤 + 导入 UI

**Files:**
- Create: `src/main/wiki/ingest-service.ts`
- Test: `src/main/wiki/__tests__/ingest-service.test.ts`
- Modify: `src/main/ipc/graph.ts`（wiki:ingestFiles 通道）
- Test: `src/main/ipc/__tests__/graph.test.ts`（扩充）
- Modify: `src/renderer/store/graphStore.ts`（wiki-link 过滤 + importWikiFiles）
- Test: `src/renderer/store/__tests__/graphStore.test.ts`（扩充）
- Modify: `src/renderer/canvas/GraphCanvas.tsx`（handleImportWikiFiles）
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`（菜单项）

- [ ] **Step 1: IngestService 失败测试**

创建 `src/main/wiki/__tests__/ingest-service.test.ts`：

```typescript
/**
 * IngestService 测试
 * 文件内容通过 readFile 注入，不触碰真实文件系统；
 * repo 用内存 fake（模式同 wiki-index-service.test.ts）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { GraphEdge, GraphNode } from '@shared/types'
import { IngestService, type IngestNodeRepo, type IngestEdgeRepo } from '../ingest-service'
import { generateId } from '../../shared/env'

type CreateNodeInput = Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>

function createFakeRepos() {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const nodeRepo: IngestNodeRepo = {
    findById: (id) => nodes.find((n) => n.id === id) ?? null,
    listByGraph: (graphId) => nodes.filter((n) => n.graphId === graphId),
    create(data) {
      const now = new Date().toISOString()
      const node: GraphNode = { ...data, id: generateId('node'), createdAt: now, updatedAt: now }
      nodes.push(node)
      return node
    },
    update(id, data) {
      const idx = nodes.findIndex((n) => n.id === id)
      if (idx === -1) throw new Error(`Node not found: ${id}`)
      nodes[idx] = { ...nodes[idx], ...data, updatedAt: new Date().toISOString() }
      return nodes[idx]
    },
  }
  const edgeRepo: IngestEdgeRepo = {
    create(data) {
      const edge: GraphEdge = { ...data, id: generateId('edge') }
      edges.push(edge)
      return edge
    },
    delete(id) {
      const idx = edges.findIndex((e) => e.id === id)
      if (idx !== -1) edges.splice(idx, 1)
    },
    listByGraph: (graphId) => edges.filter((e) => e.graphId === graphId),
  }
  return { nodeRepo, edgeRepo, nodes, edges }
}

function makeReadFile(files: Record<string, string>): (p: string) => Promise<string> {
  return async (p) => {
    if (p in files) return files[p]
    throw new Error(`ENOENT: ${p}`)
  }
}

describe('IngestService.ingestFiles', () => {
  let f: ReturnType<typeof createFakeRepos>
  beforeEach(() => { f = createFakeRepos() })

  it('导入新文件创建 draft wiki-page 节点', async () => {
    const result = await IngestService.ingestFiles(
      'g1', ['/docs/支付流程.md'], 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile({ '/docs/支付流程.md': '# 支付流程\n\n下单后扣款。' }),
    )

    expect(result.created).toHaveLength(1)
    expect(result.created[0].title).toBe('支付流程')
    expect(result.failed).toEqual([])
    const node = f.nodes.find((n) => n.title === '支付流程')!
    expect(node.status).toBe('draft')
    expect(node.wikiContent).toContain('# 支付流程')
    expect(node.wikiMeta?.sourceFile).toBe('/docs/支付流程.md')
    expect(node.wikiMeta?.importedAt).toBeTruthy()
  })

  it('标题优先级：frontmatter.title > H1 > 文件名', async () => {
    const files = {
      '/a.md': '---\ntitle: FM标题\n---\n# H1标题\n\n内容',
      '/b.md': '# H1标题\n\n内容',
      '/c-文件.md': '无标题正文',
    }
    const result = await IngestService.ingestFiles(
      'g1', Object.keys(files), 'online', f.nodeRepo, f.edgeRepo, makeReadFile(files),
    )

    const titles = result.created.map((c) => c.title).sort()
    expect(titles).toEqual(['FM标题', 'H1标题', 'c-文件'])
  })

  it('同名已有页面时追加内容并标注来源', async () => {
    // 先导入一次
    await IngestService.ingestFiles('g1', ['/a.md'], 'online', f.nodeRepo, f.edgeRepo,
      makeReadFile({ '/a.md': '# 页面A\n\n第一版' }))
    // 再导入同名新版
    const result = await IngestService.ingestFiles('g1', ['/a-v2.md'], 'online', f.nodeRepo, f.edgeRepo,
      makeReadFile({ '/a-v2.md': '# 页面A\n\n第二版' }))

    expect(result.created).toHaveLength(0)
    expect(result.updated).toHaveLength(1)
    const node = f.nodes.find((n) => n.title === '页面A')!
    expect(node.wikiContent).toContain('第一版')
    expect(node.wikiContent).toContain('第二版')
    expect(node.wikiContent).toMatch(/导入自 .*a-v2\.md/)
    expect(f.nodes.filter((n) => n.title === '页面A')).toHaveLength(1)
  })

  it('批量导入先建节点后统一落边，同批互链可解析', async () => {
    const files = {
      '/a.md': '# 页面A\n\n见 [[页面B]]',
      '/b.md': '# 页面B\n\n回链 [[页面A]]',
    }
    await IngestService.ingestFiles('g1', Object.keys(files), 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile(files))

    const a = f.nodes.find((n) => n.title === '页面A')!
    const b = f.nodes.find((n) => n.title === '页面B')!
    expect(f.edges).toHaveLength(2)
    expect(f.edges.some((e) => e.source === a.id && e.target === b.id && e.edgeType === 'wiki-link')).toBe(true)
    expect(f.edges.some((e) => e.source === b.id && e.target === a.id && e.edgeType === 'wiki-link')).toBe(true)
  })

  it('单文件失败不阻塞整批', async () => {
    const result = await IngestService.ingestFiles(
      'g1', ['/good.md', '/missing.md'], 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile({ '/good.md': '# 好页面' }),
    )

    expect(result.created).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].file).toBe('/missing.md')
    expect(result.failed[0].error).toContain('ENOENT')
  })

  it('接受绝对路径文件名回退（跨平台分隔符）', async () => {
    // 构造平台相关的绝对路径，验证 basename 与扩展名剥离
    const sep = process.platform === 'win32' ? '\\' : '/'
    const filePath = ['', 'docs', '我的页面.md'].join(sep).replace(/^\\/, 'C:\\')
    const result = await IngestService.ingestFiles(
      'g1', [filePath], 'online', f.nodeRepo, f.edgeRepo,
      makeReadFile({ [filePath]: '无标题正文' }),
    )

    expect(result.created[0]?.title).toBe('我的页面')
  })

  it('frontmatter YAML 错误的文件计入 failed', async () => {
    const result = await IngestService.ingestFiles(
      'g1', ['/bad.md'], 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile({ '/bad.md': '---\n: 非法yaml: [\n---\n正文' }),
    )

    expect(result.created).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
  })

  it('导入节点位置按网格铺开', async () => {
    const files = { '/a.md': '# A', '/b.md': '# B', '/c.md': '# C', '/d.md': '# D' }
    await IngestService.ingestFiles('g1', Object.keys(files), 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile(files))

    const positions = f.nodes.map((n) => `${n.position.x},${n.position.y}`)
    expect(new Set(positions).size).toBe(f.nodes.length)  // 无堆叠
  })
})
```

Run: `npx vitest run src/main/wiki/__tests__/ingest-service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现 IngestService**

创建 `src/main/wiki/ingest-service.ts`：

```typescript
/**
 * Wiki Ingest 服务（规则式文件导入）
 *
 * 把本地 markdown/txt 文件编译为 wiki-page 节点：
 * - 标题：frontmatter.title > 首个 H1 > 文件名（去扩展名）
 * - 同标题已存在 → 追加内容并标注来源分隔线；否则创建 draft 节点
 * - 批量先全部建/改完节点，再统一 syncNodeLinks（同批互链可解析）
 * - 单文件失败不阻塞整批
 *
 * readFile 以函数注入，便于测试且不绑定 fs 实现。
 */

import type { GraphEdge, GraphNode, GraphType, IngestResult } from '@shared/types'
import { basename } from 'path'
import { normalizeWikiTitle, parseWikiMarkdown } from './markdown-utils'
import { WikiLinkService } from '../services/wiki-link-service'

export interface IngestNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode
  update(id: string, data: Partial<GraphNode>): GraphNode
}

export interface IngestEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

export type ReadFileFn = (path: string) => Promise<string>

/** 导入节点网格布局参数 */
const GRID_START_X = 0
const GRID_START_Y = 0
const GRID_COLS = 4
const GRID_GAP_X = 260
const GRID_GAP_Y = 180

function fileBaseName(filePath: string): string {
  return basename(filePath).replace(/\.(md|markdown|txt)$/i, '')
}

function gridPosition(index: number): { x: number; y: number } {
  return {
    x: GRID_START_X + (index % GRID_COLS) * GRID_GAP_X,
    y: GRID_START_Y + Math.floor(index / GRID_COLS) * GRID_GAP_Y,
  }
}

export class IngestService {
  static async ingestFiles(
    graphId: string,
    filePaths: string[],
    graphType: GraphType,
    nodeRepo: IngestNodeRepo,
    edgeRepo: IngestEdgeRepo,
    readFile: ReadFileFn,
  ): Promise<IngestResult> {
    const result: IngestResult = { created: [], updated: [], failed: [] }
    const touchedNodeIds: string[] = []

    // 第一遍：逐文件解析并创建/更新节点
    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i]
      try {
        const markdown = await readFile(filePath)
        const parsed = parseWikiMarkdown(markdown)
        const rawTitle = parsed.title ?? fileBaseName(filePath)
        const title = normalizeWikiTitle(rawTitle)
        if (!title) {
          result.failed.push({ file: filePath, error: '无法确定页面标题（无 frontmatter.title、无 H1、文件名为空）' })
          continue
        }

        const existing = nodeRepo
          .listByGraph(graphId)
          .find((n) => n.type === 'wiki-page' && normalizeWikiTitle(n.title).toLowerCase() === title.toLowerCase())

        if (existing) {
          const separator = `\n\n---\n> 导入自 ${filePath} · ${new Date().toISOString()}\n\n`
          const appended = `${existing.wikiContent ?? ''}${separator}${parsed.body}`
          nodeRepo.update(existing.id, {
            wikiContent: appended,
            wikiMeta: { ...(existing.wikiMeta ?? {}), frontmatter: parsed.frontmatter, sourceFile: filePath, importedAt: new Date().toISOString() },
          })
          result.updated.push({ id: existing.id, title: existing.title })
          touchedNodeIds.push(existing.id)
        } else {
          const node = nodeRepo.create({
            type: 'wiki-page',
            status: 'draft',
            title,
            graphId,
            graphType,
            position: gridPosition(i),
            acceptanceCriteria: [],
            wikiContent: markdown,
            wikiMeta: { frontmatter: parsed.frontmatter, sourceFile: filePath, importedAt: new Date().toISOString() },
          })
          result.created.push({ id: node.id, title: node.title })
          touchedNodeIds.push(node.id)
        }
      } catch (err) {
        result.failed.push({ file: filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // 第二遍：统一落边（此时同批节点已全部入库，互链可解析）
    for (const nodeId of touchedNodeIds) {
      WikiLinkService.syncNodeLinks(nodeId, nodeRepo, edgeRepo)
    }

    return result
  }
}
```

Run: `npx vitest run src/main/wiki/__tests__/ingest-service.test.ts`
Expected: 7 例全部 PASS

- [ ] **Step 3: wiki:ingestFiles IPC 通道**

`src/main/ipc/graph.ts`：

1) import 区追加：

```typescript
import * as fs from 'fs/promises'
import { IngestService } from '../wiki/ingest-service'
import { validateProjectPath } from './utils'
```

2) `wiki:findDangling` 处理器后追加：

```typescript
  typedHandle('wiki:ingestFiles', async (_, graphId: string, filePaths: string[]) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new IpcError('filePaths must be a non-empty array', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (filePaths.length > 100) {
      throw new IpcError('filePaths exceeds max batch size 100', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const graphData = graphService.getGraph(graphId)
    if (!graphData) {
      throw new IpcError(`Graph not found: ${graphId}`, ErrorCode.IPC_HANDLER_ERROR)
    }
    // 路径安全：拒绝系统目录（与 validateProjectPath 同一防线）
    const validated = filePaths.map((p) => {
      ensureString('filePath', p, 1024)
      return validateProjectPath(p)
    })
    return IngestService.ingestFiles(
      graphId, validated, graphData.graph.type, nodeRepo, edgeRepo,
      (p) => fs.readFile(p, 'utf-8'),
    )
  })
```

`src/main/ipc/__tests__/graph.test.ts`：mock graphService 的 `getGraph` 返回 `{ graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [] }`（beforeEach 中已有 `getGraph: vi.fn().mockResolvedValue(null)`，本测试需覆盖），追加：

```typescript
  describe('wiki:ingestFiles', () => {
    it('rejects empty filePaths', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', [])).rejects.toThrow(IpcError)
    })

    it('rejects non-array filePaths', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', 'x.md')).rejects.toThrow(IpcError)
    })

    it('rejects oversized batch', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', Array(101).fill('/a.md'))).rejects.toThrow(IpcError)
    })

    it('rejects unknown graph', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'missing-graph', ['/tmp/a.md'])).rejects.toThrow(IpcError)
    })

    it('rejects system paths', async () => {
      (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [],
      })
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', ['/etc/passwd.md'])).rejects.toThrow(IpcError)
    })
  })
```

Run: `npx vitest run src/main/ipc/__tests__/graph.test.ts && npx tsc --noEmit`
Expected: PASS（注意 `/etc/passwd.md` 是否被 `isBlockedSystemPath` 拦截依平台而定，在 macOS 上 `/etc` 属系统目录；若该用例在开发机未抛错，改用一个肯定被拦截的路径如 `/System/x.md`）

- [ ] **Step 4: graphStore 过滤 wiki-link + importWikiFiles（TDD）**

`src/renderer/store/__tests__/graphStore.test.ts`：electronAPI mock 对象中追加：

```typescript
    'wiki:parseContent': vi.fn().mockResolvedValue({ frontmatter: {}, links: [] }),
    'wiki:ingestFiles': vi.fn().mockResolvedValue({ created: [], updated: [], failed: [] }),
```

测试文件末尾追加：

```typescript
describe('wiki-link 边过滤', () => {
  it('loadGraph 过滤 wiki-link 边，不进画布 edges', async () => {
    const wikiEdge = { id: 'e-wiki', source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'wiki-link' }
    const bizEdge = { id: 'e-biz', source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'default' }
    ;(window.electronAPI['graph:get'] as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      graph: { id: 'g1', name: 'G', type: 'online' },
      nodes: [],
      edges: [wikiEdge, bizEdge],
      bugs: [],
    })

    await useGraphStore.getState().loadGraph('g1')

    const edgeIds = useGraphStore.getState().edges.map((e) => e.id)
    expect(edgeIds).toContain('e-biz')
    expect(edgeIds).not.toContain('e-wiki')
  })

  it('createEdge 丢弃服务端返回的 wiki-link 边', async () => {
    ;(window.electronAPI['edge:create'] as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'e-wiki', source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'wiki-link',
    })

    await useGraphStore.getState().createEdge({ source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'wiki-link' })

    expect(useGraphStore.getState().edges.some((e) => e.edgeType === 'wiki-link')).toBe(false)
  })
})

describe('importWikiFiles', () => {
  it('调用 wiki:ingestFiles 并重载图', async () => {
    useGraphStore.setState({ currentGraphId: 'g1' })
    const ingest = window.electronAPI['wiki:ingestFiles'] as ReturnType<typeof vi.fn>
    ingest.mockResolvedValueOnce({ created: [{ id: 'n1', title: 'A' }], updated: [], failed: [] })

    const result = await useGraphStore.getState().importWikiFiles(['/a.md'])

    expect(ingest).toHaveBeenCalledWith('g1', ['/a.md'])
    expect(result.created).toHaveLength(1)
  })

  it('无当前图时返回空结果', async () => {
    useGraphStore.setState({ currentGraphId: null })
    const result = await useGraphStore.getState().importWikiFiles(['/a.md'])
    expect(result).toEqual({ created: [], updated: [], failed: [] })
  })
})
```

Run: `npx vitest run src/renderer/store/__tests__/graphStore.test.ts`
Expected: 新用例 FAIL（`importWikiFiles` 不存在 / 过滤未实现）

- [ ] **Step 5: 实现 graphStore 变更**

`src/renderer/store/graphStore.ts`：

1) 顶部工具函数区（`buildEdgeMap` 之后）追加：

```typescript
/** wiki-link 边只服务关系查询，不进画布 */
function excludeWikiLinkEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => e.edgeType !== 'wiki-link')
}
```

2) `GraphState` 接口 `ensureSpecialWikiPages` 声明后追加：

```typescript
  /** 导入 markdown/txt 文件为 Wiki 页面（Ingest 管线） */
  importWikiFiles: (filePaths: string[]) => Promise<import('@shared/types').IngestResult>
```

3) `loadGraph` 的 `set({...})`（第 128-135 行）改为：

```typescript
    const result = await window.electronAPI['graph:get'](graphId)
    if (result) {
      const edges = excludeWikiLinkEdges(result.edges)
      set({
        nodes: result.nodes,
        edges,
        bugs: result.bugs,
        _nodeMap: buildNodeMap(result.nodes),
        _edgeMap: buildEdgeMap(edges),
      })
    }
```

4) `createEdge` 成功回调（第 301-303 行）改为：

```typescript
      const serverItem = await window.electronAPI['edge:create'](data)
      setEdges((edges) => edges.map((e) => (e.id === optimisticId ? serverItem : e)).filter((e) => e.edgeType !== 'wiki-link'))
      return serverItem
```

5) `ensureSpecialWikiPages` 实现之后（store 对象字面量末尾）追加：

```typescript
  importWikiFiles: async (filePaths) => {
    const graphId = get().currentGraphId
    if (!graphId || filePaths.length === 0) return { created: [], updated: [], failed: [] }
    const result = await window.electronAPI['wiki:ingestFiles'](graphId, filePaths)
    await get().loadGraph(graphId)
    return result
  },
```

Run: `npx vitest run src/renderer/store/__tests__/graphStore.test.ts`
Expected: PASS

- [ ] **Step 6: 导入 UI 接线**

`src/renderer/canvas/GraphCanvas.tsx`：在 `handleCreateSpecialWikiPage` 之后追加：

```typescript
  const handleImportWikiFiles = useCallback(async () => {
    const paths = await window.electronAPI['dialog:openFiles']({ extensions: ['md', 'markdown', 'txt'] })
    if (paths.length === 0) return
    const result = await useGraphStore.getState().importWikiFiles(paths)
    setImportSummary({
      text: `导入完成：新建 ${result.created.length}，更新 ${result.updated.length}，失败 ${result.failed.length}`,
      failed: result.failed,
    })
    setShowNodeMenu(false)
  }, [])
```

组件 state 区（`showNodeMenu` 声明附近）追加：

```typescript
  const [importSummary, setImportSummary] = useState<{ text: string; failed: { file: string; error: string }[] } | null>(null)
```

`CanvasOverlay` 的 props 传入处（`<CanvasOverlay ... />`，约第 877 行）追加两个 prop：

```tsx
        onImportWikiFiles={handleImportWikiFiles}
        importSummary={importSummary}
        onDismissImportSummary={() => setImportSummary(null)}
```

`src/renderer/canvas/components/CanvasOverlay.tsx`：

1) props 接口追加：

```typescript
  onImportWikiFiles?: () => void
  importSummary?: { text: string; failed: { file: string; error: string }[] } | null
  onDismissImportSummary?: () => void
```

2) 解构处追加同名三个字段。

3) 画布右键菜单（`{showNodeMenu && (` 块内，`添加节点` 列表之后）追加：

```tsx
          <div className="border-t mt-1 pt-1">
            <button
              onClick={() => onImportWikiFiles?.()}
              data-testid="canvas-menu-import-wiki"
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted transition-colors flex items-center gap-2"
            >
              <FileUp className="w-3.5 h-3.5 text-amber-600" />
              导入 Wiki 页面…
            </button>
          </div>
```

   并从 `lucide-react` 导入 `FileUp`（文件顶部已有 lucide 导入处追加）。

4) 组件 JSX 末尾（最外层关闭标签前）追加导入结果横幅：

```tsx
      {importSummary && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 bg-background border rounded-lg shadow-lg px-4 py-2 max-w-md" data-testid="import-summary">
          <div className="flex items-center gap-3">
            <span className="text-sm">{importSummary.text}</span>
            <button onClick={onDismissImportSummary} className="text-xs text-muted-foreground hover:text-foreground">关闭</button>
          </div>
          {importSummary.failed.length > 0 && (
            <ul className="mt-1 text-xs text-destructive space-y-0.5">
              {importSummary.failed.map((f) => (
                <li key={f.file}>{f.file.split('/').pop()}：{f.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}
```

- [ ] **Step 7: 全量验证门槛**

Run: `npx tsc --noEmit && npm run lint && npm run test 2>&1 | tail -5`
Expected: tsc 零错误、lint 零警告、`Test Files 167 passed`

- [ ] **Step 8: 更新任务跟踪文档并 Commit**

勾选 T4，决策记录追加完成行。

```bash
git add src/main/wiki/ingest-service.ts src/main/wiki/__tests__/ingest-service.test.ts src/main/ipc/graph.ts src/main/ipc/__tests__/graph.test.ts src/renderer/store/graphStore.ts src/renderer/store/__tests__/graphStore.test.ts src/renderer/canvas/GraphCanvas.tsx src/renderer/canvas/components/CanvasOverlay.tsx docs/tasks/2026-07-23-wiki-link-ingest.md
git commit -m "feat(wiki): Ingest 管线 + 导入 UI + 画布过滤 wiki-link 边

- 新增 IngestService：批量文件导入，标题三级回退、同名追加、先建后链
- wiki:ingestFiles 通道含路径校验（validateProjectPath）与批量上限
- graphStore 过滤 wiki-link 边（loadGraph/createEdge），新增 importWikiFiles
- 画布右键菜单新增「导入 Wiki 页面…」+ 导入结果横幅
- 测试：ingest-service 7 例 + IPC 5 例 + store 4 例"
```

---

### Task 5: 文档收尾 + CLAUDE.md 补充

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/tasks/2026-07-23-wiki-link-ingest.md`

- [ ] **Step 1: CLAUDE.md 补充 Wiki 机制**

`CLAUDE.md` 的 `### Key Architectural Layers` 中 `**Memory System**` 段落之后插入：

```markdown
**Wiki System** (`src/main/wiki/` + `src/main/services/wiki-link-service.ts`) — LLM-Wiki 知识体。
- `markdown-utils.ts` — frontmatter/wikilink 纯函数解析（前后端唯一规则源）。
- `WikiIndexService` — Graph Index / Graph Log 特殊页与标题解析。
- `WikiLinkService` — wikilink 统一权威：解析、落边（edges 表 `edge_type='wiki-link'`）、反向链接、断链扫描。悬空链接不入库。
- `ingest-service.ts` — 规则式文件导入：标题三级回退（frontmatter.title > H1 > 文件名）、同名追加、批量先建后链。
- 落边钩子挂在 `src/main/ipc/graph.ts` 的 node:create/createBatch/update；`edge:create` 拒绝手工 wiki-link 边。
- 画布过滤 wiki-link 边（`graphStore.excludeWikiLinkEdges`）；特殊页（wikiMeta.specialPage）禁止删除。
```

同时在 `Eleven tables` 段的 `edges` 一行补充：`（含 wiki-link 类型的 Wiki 关系边）`。

- [ ] **Step 2: 任务文档收尾**

`docs/tasks/2026-07-23-wiki-link-ingest.md`：

- 「当前状态」改为：**完成** — 全部 5 个任务已交付
- 勾选 T5
- 「会话恢复指南」第 4 条改为：`当前步骤：全部完成。后续阶段（LLM Ingest、Louvain 图计算、Graph Lint）见记忆 [[llm-wiki-stepwise-plan]]`
- 决策记录追加：`- 2026-07-23：T5 完成，CLAUDE.md 补充 Wiki System 架构说明，本任务收尾`

- [ ] **Step 3: 最终全量验证**

Run: `npx tsc --noEmit && npm run lint && npm run test 2>&1 | tail -5`
Expected: 三项全绿

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/tasks/2026-07-23-wiki-link-ingest.md
git commit -m "docs(wiki): T5 收尾 — CLAUDE.md 补充 Wiki System 说明，任务文档标记完成"
```

---

## 自审记录

- **Spec 覆盖**：spec 的 WikiLinkService/数据模型（Task 2）、IPC+前端（Task 3）、Ingest（Task 4）、任务文档+构建修复+CLAUDE.md（Task 1/5）均有对应任务；spec「验证门槛」在 Task 3-5 末尾各执行一次
- **已知简化**（已在对应步骤中注明，非占位符）：预览页签采用「GFM 渲染 + [[link]] 代码样式占位 + 独立链接交互区」方案，而非在 markdown AST 内联替换 wikilink——避免 ReactMarkdown 自定义组件与行内语法混排时的文本切碎问题；`wiki:resolveLink` 兼容通道行为不变
- **类型一致性**：`WikiLinkResolution` / `ParsedWikiContent` / `DanglingLink` / `IngestResult` 在 Task 3 Step 1 统一定义于 `@shared/types/wiki`，main 与 renderer 共用；`SyncLinksResult` 仅在 main 使用，留在 wiki-link-service
- **方法签名一致性**：`IngestService.ingestFiles` 的 `nodes` 顺序即 `filePaths` 顺序（失败项跳过不位移），测试「标题优先级」用 sort 后比较因此稳定；`gridPosition(index)` 使用文件下标 `i`，失败文件会留下位置空洞——可接受，不做紧凑重排
