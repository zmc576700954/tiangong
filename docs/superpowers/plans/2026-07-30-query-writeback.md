# Query Writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 会话结束后，把会话产物（已提炼的 memories）经规则模板生成写回项，进入人工审核队列，采纳后写回 Wiki 图（追加会话日志小节 / 新建 Wiki 页面），形成「会话 → 提炼 → 审核 → 回写」闭环。

**Architecture:** 在 `PipelineRunner.createDefault()` 的 stage 数组末尾追加 writeback 阶段，从 `ctx.memories` 用规则模板生成写回项写入新表 `writeback_items`（schema v8）。渲染层 WritebackPanel 列出待审项，采纳走标准 GraphService 路径（自动 syncNodeLinks 落边）。全程规则提炼，零额外 LLM 调用。

**Tech Stack:** TypeScript (strict + exactOptionalPropertyTypes), better-sqlite3 (WAL), Electron IPC (createTypedHandle), React + Zustand, Vitest.

**Spec:** [../specs/2026-07-30-query-writeback-design.md](../specs/2026-07-30-query-writeback-design.md)

---

## 关键实现约定（所有任务共用，先读）

1. **节点 markdown 正文是 `wikiContent`**，不是 `content`（后者是 JSON 序列化的富文本）。所有「追加正文」「新建页面正文」都写 `wikiContent` 字段。
2. **graphId 从 `ctx.nodeId` 反查节点获得**（`node.graphId`），不要用 `ctx.projectId`（管线里它是 workingDirectory，MemoryItem 里它是 graphs.id，语义二义）。
3. **writeback 阶段插到 `defaultStages` 数组末尾**（persist 之后、return 之前），StageOverride.skip/replace 机制可直接用于测试。
4. **DB 相关测试一律用真实 better-sqlite3 内存库**（`new Database(':memory:')` + 跑真实 `migrate()`），不用内存 fake repo——吸取阶段三 C1（communityId 未持久化被 fake repo 掩盖）的教训。
5. **每个 commit 前过三门槛**：`npx tsc --noEmit` 零错误、`npm run test` 全绿、`npm run lint` 零警告。
6. `normalizeWikiTitle` 在 `src/main/wiki/markdown-utils.ts:131`，`WikiLinkService.syncNodeLinks` 由 `node:update`/`node:create` IPC 内部触发，无需手动调。
7. Node IDs 用 `generateId()`（`src/main/shared/env.ts`），前缀 `writeback_`。

---

## File Structure

| 文件 | 责任 | 新建/修改 |
|---|---|---|
| `src/shared/types/wiki.ts` | WritebackItem/WritebackKind/WritebackStatus 类型 | 修改 |
| `src/shared/types/ipc.ts` | 4 个 writeback IPC 通道签名 | 修改 |
| `src/preload/index.ts` | 4 个通道白名单 | 修改 |
| `src/main/database.ts` | writeback_items 表 + graphs.writeback_disabled 列，schema v8 | 修改 |
| `src/main/repositories/writeback-repository.ts` | writeback_items CRUD | 新建 |
| `src/main/services/writeback-service.ts` | 规则模板生成 + 去重 + 采纳落点 | 新建 |
| `src/main/memory/pipeline.ts` | createDefault 末尾插 writeback 阶段 | 修改 |
| `src/main/settings.ts` | writeback.enabled 全局开关（默认 true） | 修改 |
| `src/main/ipc/graph.ts` | 4 个 writeback IPC handler | 修改 |
| `src/renderer/store/graphStore.ts` | 4 个 writeback action | 修改 |
| `src/renderer/components/wiki/WritebackPanel.tsx` | 审核队列面板 | 新建 |
| `src/renderer/canvas/GraphCanvas.tsx` + `components/CanvasOverlay.tsx` | 「审核队列(N)」入口 | 修改 |
| `src/main/wiki/graph-lint-service.ts` | M4：断链扫描排除 community 页 | 修改 |
| `src/renderer/components/wiki/LintPanel.tsx` | a11y：可点击行键盘可达 | 修改 |

---

### Task 1: 共享类型 + schema v8 + WritebackRepository

**Files:**
- Modify: `src/shared/types/wiki.ts`
- Modify: `src/main/database.ts`
- Create: `src/main/repositories/writeback-repository.ts`
- Test: `src/main/repositories/__tests__/writeback-repository.test.ts`

- [ ] **Step 1: 在 `src/shared/types/wiki.ts` 末尾追加类型**

```ts
export type WritebackKind = 'append-log' | 'new-page'
export type WritebackStatus = 'pending' | 'accepted' | 'discarded'

export interface WritebackItem {
  id: string
  graphId: string
  kind: WritebackKind
  /** 关联节点 id：append-log=追加目标；new-page=源节点（采纳时连边用）。恒非 null。 */
  targetNodeId: string
  title: string
  content: string
  sourceSessionId: string
  confidence: number
  status: WritebackStatus
  createdAt: string
  resolvedAt: string | null
}
```

- [ ] **Step 2: schema v8 — `src/main/database.ts`**

将 `CURRENT_SCHEMA_VERSION` 从 `7` 改为 `8`。在 `migrate()` 内联 DDL 区（其他 CREATE TABLE 旁）加：

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS writeback_items (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('append-log','new-page')),
    target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_writeback_graph_status ON writeback_items(graph_id, status);
  CREATE INDEX IF NOT EXISTS idx_writeback_session ON writeback_items(source_session_id);
`)
```

在 `runIncrementalMigrations()` 内（仿 community_id 的 `addColumnSafe` 调用）加：

```ts
addColumnSafe('graphs', 'writeback_disabled', 'INTEGER DEFAULT 0')
```

> 注意：`addColumnSafe` 的签名以 database.ts 现有定义为准（阶段三调用为 `addColumnSafe('nodes','community_id','TEXT')`）。

- [ ] **Step 3: 写失败测试 `writeback-repository.test.ts`（真实内存库）**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { WritebackRepository } from '../writeback-repository'

// 建真实内存库并跑最小建表（只建本测试依赖的 graphs/nodes/writeback_items）
function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY, name TEXT, type TEXT, project_path TEXT,
      writeback_disabled INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, graph_id TEXT, title TEXT);
    CREATE TABLE writeback_items (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('append-log','new-page')),
      target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
      created_at TEXT NOT NULL, resolved_at TEXT
    );
  `)
  db.prepare(`INSERT INTO graphs (id,name,type,created_at,updated_at) VALUES ('g1','G','online','2026-01-01','2026-01-01')`).run()
  db.prepare(`INSERT INTO nodes (id,graph_id,title) VALUES ('n1','g1','Node A')`).run()
  return db
}

describe('WritebackRepository', () => {
  let db: Database.Database
  let repo: WritebackRepository
  beforeEach(() => { db = makeDb(); repo = new WritebackRepository(db) })

  it('create + listPending round-trips all fields', () => {
    repo.create({
      graphId: 'g1', kind: 'append-log', targetNodeId: 'n1',
      title: '会话日志 · 2026-07-30', content: '## 会话日志',
      sourceSessionId: 'sess_1', confidence: 0.82,
    })
    const items = repo.listPending('g1')
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('append-log')
    expect(items[0].targetNodeId).toBe('n1')
    expect(items[0].confidence).toBeCloseTo(0.82)
    expect(items[0].status).toBe('pending')
    expect(items[0].id).toMatch(/^writeback-/)
    expect(items[0].resolvedAt).toBeNull()
  })

  it('findBySession finds existing pending/accepted items for dedup', () => {
    repo.create({ graphId: 'g1', kind: 'new-page', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 'sess_1', confidence: 0.5 })
    expect(repo.findBySession('sess_1')).toHaveLength(1)
    expect(repo.findBySession('sess_other')).toHaveLength(0)
  })

  it('updateStatus sets status + resolvedAt; listPending excludes resolved', () => {
    const item = repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 's', confidence: 0.5 })
    repo.updateStatus(item.id, 'accepted')
    expect(repo.listPending('g1')).toHaveLength(0)
    expect(repo.countPending('g1')).toBe(0)
  })

  it('countPending counts only pending', () => {
    repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'A', content: 'C', sourceSessionId: 's1', confidence: 0.5 })
    repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'B', content: 'C', sourceSessionId: 's2', confidence: 0.5 })
    expect(repo.countPending('g1')).toBe(2)
  })

  it('graph delete cascades writeback_items', () => {
    repo.create({ graphId: 'g1', kind: 'append-log', targetNodeId: 'n1', title: 'T', content: 'C', sourceSessionId: 's', confidence: 0.5 })
    // nodes.graph_id 在真实 schema 中也是 ON DELETE CASCADE，先删图会级联清节点与 writeback_items
    db.prepare(`DELETE FROM graphs WHERE id='g1'`).run()
    expect(repo.listPending('g1')).toHaveLength(0)
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npx vitest run src/main/repositories/__tests__/writeback-repository.test.ts`
Expected: FAIL — `WritebackRepository` 不存在 / 模块解析失败

- [ ] **Step 5: 实现 `writeback-repository.ts`**

仿 `node-repository.ts` 的 rowToX 映射与注入式 db 模式：

```ts
import type BetterSqlite3 from 'better-sqlite3'
import type { WritebackItem, WritebackStatus } from '@shared/types/wiki'
import { generateId } from '../shared/env'

export class WritebackRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  private rowToItem(row: Record<string, unknown>): WritebackItem {
    return {
      id: row.id as string,
      graphId: row.graph_id as string,
      kind: row.kind as WritebackItem['kind'],
      targetNodeId: (row.target_node_id as string | null) ?? null,
      title: row.title as string,
      content: row.content as string,
      sourceSessionId: row.source_session_id as string,
      confidence: row.confidence as number,
      status: row.status as WritebackStatus,
      createdAt: row.created_at as string,
      resolvedAt: (row.resolved_at as string | null) ?? null,
    }
  }

  create(data: Omit<WritebackItem, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): WritebackItem {
    const id = generateId('writeback')
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO writeback_items
        (id, graph_id, kind, target_node_id, title, content, source_session_id, confidence, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
    `).run(id, data.graphId, data.kind, data.targetNodeId, data.title, data.content, data.sourceSessionId, data.confidence, now)
    return { ...data, id, status: 'pending', createdAt: now, resolvedAt: null }
  }

  listPending(graphId: string): WritebackItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM writeback_items WHERE graph_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    ).all(graphId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToItem(r))
  }

  countPending(graphId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM writeback_items WHERE graph_id = ? AND status = 'pending'`,
    ).get(graphId) as { c: number }
    return row.c
  }

  findBySession(sourceSessionId: string): WritebackItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM writeback_items WHERE source_session_id = ? AND status IN ('pending','accepted')`,
    ).all(sourceSessionId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToItem(r))
  }

  findById(id: string): WritebackItem | null {
    const row = this.db.prepare(`SELECT * FROM writeback_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? this.rowToItem(row) : null
  }

  updateStatus(id: string, status: WritebackStatus): void {
    this.db.prepare(`UPDATE writeback_items SET status = ?, resolved_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id)
  }
}
```

> 确认 `generateId` 在 `src/main/shared/env.ts` 的签名（阶段三用 `generateId('node')` 等前缀形式）。若签名不同，以现网为准。

- [ ] **Step 6: 跑测试确认通过 + 三门槛**

Run: `npx vitest run src/main/repositories/__tests__/writeback-repository.test.ts` → PASS
Run: `npx tsc --noEmit && npm run lint`

- [ ] **Step 7: Commit**

```bash
git add src/shared/types/wiki.ts src/main/database.ts src/main/repositories/writeback-repository.ts src/main/repositories/__tests__/writeback-repository.test.ts
git commit -m "feat(wiki): writeback_items 表 schema v8 + WritebackRepository（真实库测试）"
```

---

### Task 2: WritebackService — 规则模板生成 + 去重

**Files:**
- Create: `src/main/services/writeback-service.ts`
- Test: `src/main/services/__tests__/writeback-service.test.ts`

> 本任务只覆盖「生成」纯逻辑（用 fake repo，无 DB）。采纳落点在 Task 3。

- [ ] **Step 1: 写失败测试（fake repo，纯逻辑）**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { WritebackService } from '../writeback-service'
import type { MemoryItem } from '@shared/types'
import type { WritebackItem } from '@shared/types/wiki'

function mem(over: Partial<MemoryItem>): Omit<MemoryItem, 'id'> {
  return {
    session_id: 'sess_1', kind: 'discovery', project_id: 'g1', node_id: 'n1',
    title: '默认标题', narrative: 'narrative', facts: [], concepts: [],
    files_read: [], files_modified: [], adapter_name: 'claude-code',
    token_cost: 100, confidence: 0.8, created_at: '2026-07-30T00:00:00Z',
    ...over,
  } as Omit<MemoryItem, 'id'>
}

// fake writeback repo（纯内存，验证生成逻辑，不碰 DB）
function fakeWritebackRepo() {
  const items: WritebackItem[] = []
  return {
    items,
    create: (d: any) => { const it = { ...d, id: `writeback_${items.length}`, status: 'pending', createdAt: 'now', resolvedAt: null }; items.push(it); return it },
    findBySession: (sid: string) => items.filter((i) => i.sourceSessionId === sid),
  }
}

describe('WritebackService.generate', () => {
  let service: WritebackService
  let repo: ReturnType<typeof fakeWritebackRepo>
  beforeEach(() => {
    repo = fakeWritebackRepo()
    service = new WritebackService(repo as any, { findExistingTitles: () => [] } as any)
  })

  it('generates append-log item targeting nodeId with 会话日志 section', () => {
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'Node A', sessionId: 'sess_1', memories: [mem({ title: '发现 X' })] })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('append-log')
    expect(out[0].targetNodeId).toBe('n1')
    expect(out[0].content).toContain('## 会话日志')
    expect(out[0].content).toContain('发现 X')
  })

  it('returns empty when memories empty', () => {
    expect(service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories: [] })).toEqual([])
  })

  it('skips generation when session already has pending/accepted items (dedup)', () => {
    service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 'sess_1', memories: [mem({})] })
    const again = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 'sess_1', memories: [mem({})] })
    expect(again).toEqual([])
  })

  it('truncates to top-5 memories by confidence and averages confidence', () => {
    const memories = Array.from({ length: 8 }, (_, i) => mem({ title: `m${i}`, confidence: (i + 1) / 10 }))
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    // top5 confidence: 0.8,0.7,0.6,0.5,0.4 → mean 0.6
    expect(out[0].confidence).toBeCloseTo(0.6)
  })

  it('generates new-page item when >=2 memories share a novel concept', () => {
    const memories = [
      mem({ title: 'A', concepts: ['auth-flow'], confidence: 0.9 }),
      mem({ title: 'B', concepts: ['auth-flow'], confidence: 0.9 }),
    ]
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    const np = out.find((i) => i.kind === 'new-page')
    expect(np).toBeDefined()
    expect(np!.content).toContain('auth-flow')
    expect(np!.targetNodeId).toBe('n1') // new-page 的 targetNodeId 存源节点 id
  })

  it('does NOT generate new-page when concept matches existing title', () => {
    const svc = new WritebackService(repo as any, { findExistingTitles: () => ['auth-flow'] } as any)
    const memories = [mem({ concepts: ['auth-flow'] }), mem({ concepts: ['auth-flow'] })]
    const out = svc.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    expect(out.find((i) => i.kind === 'new-page')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/__tests__/writeback-service.test.ts`
Expected: FAIL — `WritebackService` 不存在

- [ ] **Step 3: 实现 `writeback-service.ts`（只 generate，accept 留 Task 3）**

```ts
import type { MemoryItem } from '@shared/types'
import type { WritebackItem, WritebackKind } from '@shared/types/wiki'
import { normalizeWikiTitle } from '../wiki/markdown-utils'

export interface WritebackRepoLike {
  create(data: Omit<WritebackItem, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): WritebackItem
  findBySession(sourceSessionId: string): WritebackItem[]
}

/** 提供「现有节点标题」查询，用于 new-page concept 去重 */
export interface NodeTitleSource {
  findExistingTitles(graphId: string): string[]
}

export interface GenerateInput {
  graphId: string
  nodeId: string
  nodeTitle: string
  sessionId: string
  memories: Array<Omit<MemoryItem, 'id'>>
}

const TOP_N = 5
const MIN_CLUSTER = 2

export class WritebackService {
  constructor(
    private readonly repo: WritebackRepoLike,
    private readonly titles: NodeTitleSource,
  ) {}

  generate(input: GenerateInput): WritebackItem[] {
    if (input.memories.length === 0) return []
    // 按会话去重：已有 pending/accepted 项则跳过
    if (this.repo.findBySession(input.sessionId).length > 0) return []

    const top = [...input.memories]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, TOP_N)
    const confidence = top.reduce((s, m) => s + (m.confidence ?? 0), 0) / top.length

    const created: WritebackItem[] = []
    created.push(this.repo.create({
      graphId: input.graphId,
      kind: 'append-log',
      targetNodeId: input.nodeId,
      title: `会话日志 · ${new Date().toISOString().slice(0, 10)}`,
      content: this.buildAppendLog(top, input),
      sourceSessionId: input.sessionId,
      confidence,
    }))

    for (const cluster of this.clusterNovelConcepts(top, input.graphId)) {
      created.push(this.repo.create({
        graphId: input.graphId,
        kind: 'new-page',
        targetNodeId: input.nodeId, // 源节点 id，采纳时连边用
        title: cluster.concept,
        content: this.buildNewPage(cluster.concept, cluster.memories, input),
        sourceSessionId: input.sessionId,
        confidence,
      }))
    }
    return created
  }

  private buildAppendLog(top: Array<Omit<MemoryItem, 'id'>>, input: GenerateInput): string {
    const adapter = top[0]?.adapter_name ?? 'agent'
    const bullets = top.map((m) => `- ${m.title}`).join('\n')
    const detail = top
      .map((m) => `### ${m.title}\n\n${m.narrative}${m.facts.length ? '\n\n' + m.facts.map((f) => `- ${f}`).join('\n') : ''}`)
      .join('\n\n')
    return [
      '',
      `## 会话日志 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      `> 来源：${adapter} 会话 · 置信度 ${(top.reduce((s, m) => s + (m.confidence ?? 0), 0) / top.length).toFixed(2)}`,
      '',
      bullets,
      '',
      '<details><summary>详情</summary>',
      '',
      detail,
      '',
      '</details>',
      '',
    ].join('\n')
  }

  private buildNewPage(concept: string, memories: Array<Omit<MemoryItem, 'id'>>, input: GenerateInput): string {
    const list = memories.map((m) => `- ${m.title}`).join('\n')
    return [
      '---',
      `title: ${concept}`,
      '---',
      '',
      `# ${concept}`,
      '',
      '> 由 Query Writeback 从会话提炼 · 待人工整理',
      '',
      `- 源节点：[[${input.nodeTitle}]]`,
      '',
      list,
      '',
    ].join('\n')
  }

  private clusterNovelConcepts(
    top: Array<Omit<MemoryItem, 'id'>>,
    graphId: string,
  ): Array<{ concept: string; memories: Array<Omit<MemoryItem, 'id'>> }> {
    const existing = new Set(this.titles.findExistingTitles(graphId).map((t) => normalizeWikiTitle(t).toLowerCase()))
    const byConcept = new Map<string, Array<Omit<MemoryItem, 'id'>>>()
    for (const m of top) {
      for (const c of m.concepts ?? []) {
        const key = normalizeWikiTitle(c).toLowerCase()
        if (existing.has(key)) continue
        if (!byConcept.has(c)) byConcept.set(c, [])
        byConcept.get(c)!.push(m)
      }
    }
    return [...byConcept.entries()]
      .filter(([, ms]) => ms.length >= MIN_CLUSTER)
      .map(([concept, memories]) => ({ concept, memories }))
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 三门槛**

Run: `npx vitest run src/main/services/__tests__/writeback-service.test.ts` → PASS
Run: `npx tsc --noEmit && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add src/main/services/writeback-service.ts src/main/services/__tests__/writeback-service.test.ts
git commit -m "feat(wiki): WritebackService 规则模板生成 + concept 聚类 + 按会话去重"
```

---

### Task 3: WritebackService.accept — 采纳落点（真实库）

**Files:**
- Modify: `src/main/services/writeback-service.ts`
- Test: `src/main/services/__tests__/writeback-service-accept.test.ts`

- [ ] **Step 1: 写失败测试（真实内存库，走真 NodeRepository + WikiLinkService 落边）**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { WritebackService } from '../writeback-service'
import { NodeRepository } from '../../repositories/node-repository'
import { EdgeRepository } from '../../repositories/edge-repository'
import { WritebackRepository } from '../../repositories/writeback-repository'

// 真实内存库：建 graphs/nodes/edges/writeback_items 最小表结构（列名须与真实 migrate 一致）
function makeDb() { /* 见 Task 1 makeDb，另补 nodes/edges 全列——以 node-repository.ts create SQL 所需列为准 */ }

describe('WritebackService.accept', () => {
  let db: Database.Database
  let service: WritebackService
  let writebackRepo: WritebackRepository
  let nodeRepo: NodeRepository
  beforeEach(() => {
    db = makeDb()
    writebackRepo = new WritebackRepository(db)
    nodeRepo = new NodeRepository(db)
    const edgeRepo = new EdgeRepository(db)
    service = new WritebackService(writebackRepo, /* titleSource over nodeRepo */ undefined as any, { nodeRepo, edgeRepo } as any)
  })

  it('accept append-log appends section to node wikiContent and marks accepted', () => {
    // 建目标节点（wiki-page），其 wikiContent 已有正文
    // create append-log item → accept → 节点 wikiContent 含 ## 会话日志 → item.status accepted
  })

  it('accept append-log is idempotent when section already present', () => {
    // accept 两次 → wikiContent 只含一次该小节
  })

  it('accept new-page creates wiki-page node + structural edge to source node', () => {
    // create new-page item(targetNodeId=源节点 id) → accept → 新 wiki-page 节点存在 → edge 存在
  })

  it('accept throws IpcError when target node no longer exists', () => {
    // 构造 item 后直接绕过外键删目标节点（或 accept 时节点已不可查）→ accept 抛 IpcError
    // 注：target_node_id 为 ON DELETE CASCADE，真实删节点会级联清 item；此用例验证防御性校验
  })
})
```

> 每个 `it` 内的注释为占位提示——实现者须补全真实断言（建节点用 `nodeRepo.create`，字段名以 `node-repository.ts` 的 create SQL 为准）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/main/services/__tests__/writeback-service-accept.test.ts`
Expected: FAIL — `accept` 未实现

- [ ] **Step 3: 扩展 `writeback-service.ts` 加 accept**

改构造函数加可选依赖（保持 Task 2 测试兼容，用可选参数）：

```ts
import type { NodeRepository } from '../repositories/node-repository'
import type { EdgeRepository } from '../repositories/edge-repository'
import { WikiLinkService } from './wiki-link-service'
import { IpcError, ErrorCode } from '../errors'
import { generateId } from '../shared/env'

// 构造函数第三参数可选（Task 2 纯生成测试不传）
constructor(
  private readonly repo: WritebackRepoLike,
  private readonly titles: NodeTitleSource,
  private readonly deps?: { nodeRepo: NodeRepository; edgeRepo: EdgeRepository },
) {}

accept(itemId: string): void {
  if (!this.deps) throw new IpcError('WritebackService accept 需要 nodeRepo/edgeRepo', ErrorCode.IPC_INVALID_ARGUMENT)
  const item = this.repo.findById(itemId)
  if (!item) throw new IpcError(`写回项不存在: ${itemId}`, ErrorCode.IPC_INVALID_ARGUMENT)
  if (item.status !== 'pending') return // 幂等：已处理直接返回

  if (item.kind === 'append-log') {
    this.acceptAppendLog(item)
  } else {
    this.acceptNewPage(item)
  }
  this.repo.updateStatus(itemId, 'accepted')
}

private acceptAppendLog(item: WritebackItem): void {
  const node = item.targetNodeId ? this.deps!.nodeRepo.findById(item.targetNodeId) : null
  if (!node) throw new IpcError('目标节点已删除，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
  const current = node.wikiContent ?? ''
  if (current.includes(item.title)) {
    return // 幂等：小节已存在，跳过写入（外层仍标 accepted）
  }
  this.deps!.nodeRepo.update(node.id, { wikiContent: current + item.content })
  WikiLinkService.syncNodeLinks(node.id, this.deps!.nodeRepo, this.deps!.edgeRepo)
}

private acceptNewPage(item: WritebackItem): void {
  const sourceId = item.targetNodeId // new-page：targetNodeId 存源节点 id
  const source = this.deps!.nodeRepo.findById(sourceId)
  if (!source) throw new IpcError('源节点已删除，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
  const created = this.deps!.nodeRepo.create({
    graphId: item.graphId,
    type: 'wiki-page',
    title: item.title,
    wikiContent: item.content,
    // 位置/状态等以 node-repository.create 的字段为准
  } as any)
  WikiLinkService.syncNodeLinks(created.id, this.deps!.nodeRepo, this.deps!.edgeRepo)
  // 连源节点（结构性边，非 wiki-link）
  this.deps!.edgeRepo.create({
    graphId: item.graphId,
    sourceId,
    targetId: created.id,
    edgeType: 'hierarchy', // 以 edge-repository.ts 允许值为准，不可用 'wiki-link'
  } as any)
}
```

> **实现者注意**：`WritebackItem.targetNodeId` 恒非 null，语义为「关联节点」——append-log 时是追加目标，new-page 时是源节点（采纳时连边用）。连边 `edgeType` 以 `edge-repository.ts` 允许值为准，不可用 `'wiki-link'`（IPC 层已拒绝手工 wiki-link 边）。

- [ ] **Step 4: 跑测试确认通过 + 三门槛**

Run: `npx vitest run src/main/services/__tests__/writeback-service-accept.test.ts` → PASS
Run: `npx tsc --noEmit && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add src/main/services/writeback-service.ts src/main/services/__tests__/writeback-service-accept.test.ts
git commit -m "feat(wiki): WritebackService.accept — append-log 幂等追加 + new-page 建页连边（真实库）"
```

---

### Task 4: 管线接入 writeback 阶段 + 全局/项目开关

**Files:**
- Modify: `src/main/memory/pipeline.ts`
- Modify: `src/main/settings.ts`
- Test: `src/main/memory/__tests__/pipeline-writeback.test.ts`

- [ ] **Step 1: settings 加全局开关**

`src/main/settings.ts`：在 settings 类型与默认值加 `writeback: { enabled: boolean }`，默认 `{ enabled: true }`。提供 getter（仿现有设置项的读写模式）。

- [ ] **Step 2: 写失败测试（StageOverride 注入 + fake deps）**

```ts
import { describe, it, expect } from 'vitest'
import { PipelineRunner } from '../pipeline'

describe('writeback stage', () => {
  it('is skipped when globally disabled', async () => {
    // 构造 writebackEnabled=() => false → run pipeline → writebackService.generate 不被调
  })
  it('is skipped when project writeback_disabled=1', async () => {})
  it('calls generate with graphId resolved from nodeId (not projectId)', async () => {})
  it('stage failure does not block pipeline', async () => {
    // writeback stage 抛错 → result.errors 含该错，其余阶段正常
  })
})
```

> 实现者用 `PipelineRunner.createDefault({ replace: { writeback: spyStage } })` 或注入 fake writeback 阶段验证 enabled 逻辑；真正的 generate 用 fake WritebackService。

- [ ] **Step 3: 在 createDefault 的 defaultStages 数组末尾（persist 之后）插 writeback 阶段**

```ts
{
  name: 'writeback',
  enabled: () => {
    // 全局开关 + 项目覆盖（单向：全局关→false；全局开→项目可关）
    try {
      const { getSettings } = await import('../settings') // 以现网导出为准
      return getSettings().get('writeback.enabled') !== false
    } catch { return true }
  },
  process: async (ctx) => {
    if (!ctx.nodeId || !ctx.memories || ctx.memories.length === 0) return ctx
    try {
      const { getClient } = await import('../database')
      const { NodeRepository } = await import('../repositories/node-repository')
      const { WritebackRepository } = await import('../repositories/writeback-repository')
      const { WritebackService } = await import('../services/writeback-service')
      const db = getClient()
      const nodeRepo = new NodeRepository(db)
      const node = nodeRepo.findById(ctx.nodeId)
      if (!node) return ctx
      // graphId 从节点反查，不用 ctx.projectId（语义二义）
      const graphId = node.graphId
      // 项目覆盖：graphs.writeback_disabled=1 → 跳过
      const g = db.prepare('SELECT writeback_disabled FROM graphs WHERE id = ?').get(graphId) as { writeback_disabled: number } | undefined
      if (g?.writeback_disabled === 1) return ctx
      // 特殊页不写入
      if ((node.wikiMeta as any)?.specialPage) return ctx

      const writebackRepo = new WritebackRepository(db)
      const titles = { findExistingTitles: (gid: string) => nodeRepo.listByGraph(gid).map((n) => n.title) }
      const service = new WritebackService(writebackRepo, titles, { nodeRepo, edgeRepo: new (await import('../repositories/edge-repository')).EdgeRepository(db) })
      service.generate({
        graphId,
        nodeId: node.id,
        nodeTitle: node.title,
        sessionId: ctx.sessionId,
        memories: ctx.memories as Array<Omit<MemoryItem, 'id'>>,
      })
    } catch (err) {
      logger.warn('writeback stage failed:', err)
    }
    return ctx
  },
},
```

> enabled() 不能是 async（PipelineStage.enabled 签名是同步 `() => boolean`）。把全局/项目判断都放进 `process` 内部开头（读 settings 同步），`enabled` 可省略或返回 true。实现者以 `PipelineStage` 实际签名为准——若 enabled 仅同步，则把开关判断移入 process。

- [ ] **Step 4: 跑测试确认通过 + 三门槛**

Run: `npx vitest run src/main/memory/__tests__/pipeline-writeback.test.ts` → PASS
Run: `npx tsc --noEmit && npm run lint && npm run test`

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/pipeline.ts src/main/settings.ts src/main/memory/__tests__/pipeline-writeback.test.ts
git commit -m "feat(wiki): 管线末尾接 writeback 阶段 + 全局/项目开关（默认开，项目单向覆盖）"
```

---

### Task 5: IPC 接线 + preload 白名单

**Files:**
- Modify: `src/shared/types/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc/graph.ts`
- Test: `src/main/ipc/__tests__/graph.test.ts`（追加 writeback 组，真实内存库）

- [ ] **Step 1: `src/shared/types/ipc.ts` IpcApi 加 4 个签名**

```ts
'wiki:listWriteback': (graphId: string) => Promise<WritebackItem[]>
'wiki:countWriteback': (graphId: string) => Promise<number>
'wiki:acceptWriteback': (itemId: string) => Promise<void>
'wiki:discardWriteback': (itemId: string) => Promise<void>
```

顶部 import `WritebackItem` from `./wiki`。

- [ ] **Step 2: `src/preload/index.ts` 白名单加 4 个通道名**（仿 wiki:lint 等现有项）

- [ ] **Step 3: `src/main/ipc/graph.ts` 注册 4 个 handler**

在 `registerGraphHandlers` 内（复用已注入的 db / nodeRepo / edgeRepo）：

```ts
const writebackRepo = new WritebackRepository(db)
const writebackService = new WritebackService(
  writebackRepo,
  { findExistingTitles: (gid: string) => nodeRepo.listByGraph(gid).map((n) => n.title) },
  { nodeRepo, edgeRepo },
)

typedHandle('wiki:listWriteback', async (_, graphId: string) => {
  ensureString('graphId', graphId, MAX_ID_LEN)
  return writebackRepo.listPending(graphId)
})
typedHandle('wiki:countWriteback', async (_, graphId: string) => {
  ensureString('graphId', graphId, MAX_ID_LEN)
  return writebackRepo.countPending(graphId)
})
typedHandle('wiki:acceptWriteback', async (_, itemId: string) => {
  ensureString('itemId', itemId, MAX_ID_LEN)
  writebackService.accept(itemId)
})
typedHandle('wiki:discardWriteback', async (_, itemId: string) => {
  ensureString('itemId', itemId, MAX_ID_LEN)
  const item = writebackRepo.findById(itemId)
  if (item) writebackRepo.updateStatus(itemId, 'discarded')
})
```

> import `WritebackRepository`、`WritebackService`。`ensureString` 的实参顺序以 `src/main/ipc/utils.ts` 现网签名为准（阶段三调用形如 `ensureString('graphId', graphId, MAX_ID_LEN)`）。

- [ ] **Step 4: 写失败测试（真实内存库 happy path + 参数校验）**

```ts
// 仿阶段三 graph.test.ts 真实库模式：建内存库跑 migrate → registerGraphHandlers → 直接 invoke handler
it('wiki:listWriteback returns pending items for graph', async () => { /* seed writeback_items → 调 handler → 断言数组 */ })
it('wiki:countWriteback returns pending count', async () => {})
it('wiki:acceptWriteback rejects empty itemId', async () => { await expect(invoke('wiki:acceptWriteback', '')).rejects.toThrow() })
it('wiki:discardWriteback marks item discarded', async () => {})
```

- [ ] **Step 5: 跑测试确认通过 + 三门槛**

Run: `npx vitest run src/main/ipc/__tests__/graph.test.ts` → PASS
Run: `npx tsc --noEmit && npm run lint`

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/ipc.ts src/preload/index.ts src/main/ipc/graph.ts src/main/ipc/__tests__/graph.test.ts
git commit -m "feat(wiki): writeback IPC 4 通道 + preload 白名单（真实库测试）"
```

---

### Task 6: graphStore + WritebackPanel

**Files:**
- Modify: `src/renderer/store/graphStore.ts`
- Create: `src/renderer/components/wiki/WritebackPanel.tsx`
- Test: `src/renderer/store/__tests__/graphStore.test.ts`（追加）+ `src/renderer/components/wiki/__tests__/WritebackPanel.test.tsx`（新建）

- [ ] **Step 1: graphStore 加 4 个 action**（仿阶段三 lintGraph/computeCommunities）

```ts
listWriteback: async () => {
  const graphId = get().currentGraphId
  if (!graphId) return []
  return window.ipcRenderer.invoke('wiki:listWriteback', graphId)
},
countWriteback: async () => {
  const graphId = get().currentGraphId
  if (!graphId) return 0
  return window.ipcRenderer.invoke('wiki:countWriteback', graphId)
},
acceptWriteback: async (itemId: string) => { await window.ipcRenderer.invoke('wiki:acceptWriteback', itemId) },
discardWriteback: async (itemId: string) => { await window.ipcRenderer.invoke('wiki:discardWriteback', itemId) },
```

> IPC 调用方式以 graphStore 现网为准（可能封装在 `window.bizgraph` 或自定义 client）。

- [ ] **Step 2: WritebackPanel 组件（仿 LintPanel 布局）**

props：`{ items: WritebackItem[]; loading?: boolean; onAccept(id): void; onDiscard(id): void; onNavigate?(nodeId): void; onClose(): void }`。

- 列出待审项：kind 徽章（追加日志/新页面）、title、置信度、来源会话、content 预览（折叠）
- 每行「采纳」「丢弃」按钮；append-log 行可点「定位节点」→ onNavigate(targetNodeId)
- 空态显示「暂无待审核的写回项」
- 可点击行加 `role="button"` `tabIndex={0}` `onKeyDown`（Enter/Space）——连同 LintPanel a11y 一并遵循

- [ ] **Step 3: 写测试**

`graphStore.test.ts`：4 个 action 调正确通道（mock ipc）。
`WritebackPanel.test.tsx`（仿 LintPanel.test）：渲染项、采纳/丢弃回调、空态、置信度显示、键盘可达。

- [ ] **Step 4: 跑测试确认通过 + 三门槛**

Run: `npx vitest run src/renderer/store/__tests__/graphStore.test.ts src/renderer/components/wiki/__tests__/WritebackPanel.test.tsx` → PASS
Run: `npx tsc --noEmit && npm run lint`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/graphStore.ts src/renderer/components/wiki/WritebackPanel.tsx src/renderer/store/__tests__/graphStore.test.ts src/renderer/components/wiki/__tests__/WritebackPanel.test.tsx
git commit -m "feat(wiki): graphStore writeback action + WritebackPanel 审核面板"
```

---

### Task 7: 画布入口「审核队列(N)」

**Files:**
- Modify: `src/renderer/canvas/GraphCanvas.tsx`
- Modify: `src/renderer/canvas/components/CanvasOverlay.tsx`

- [ ] **Step 1: CanvasOverlay 菜单加「审核队列(N)」**

仿阶段三「图检查（Lint）」入口：加可选 props `onOpenWriteback?: () => void`、`writebackCount?: number`。菜单项 label `审核队列${writebackCount ? ` (${writebackCount})` : ''}`，`onOpenWriteback` 存在时显示。

- [ ] **Step 2: GraphCanvas 接 writeback 状态**

仿 lint 的 state 模式：

```ts
const [writebackOpen, setWritebackOpen] = useState(false)
const [writebackItems, setWritebackItems] = useState<WritebackItem[]>([])
const [writebackCount, setWritebackCount] = useState(0)

const refreshWriteback = useCallback(async () => {
  try {
    const [items, count] = await Promise.all([
      useGraphStore.getState().listWriteback(),
      useGraphStore.getState().countWriteback(),
    ])
    setWritebackItems(items); setWritebackCount(count)
  } catch (err) { console.error('[GraphCanvas] writeback refresh failed:', err) }
}, [])

const handleOpenWriteback = useCallback(async () => {
  await refreshWriteback(); setWritebackOpen(true)
}, [refreshWriteback])

const handleAccept = useCallback(async (id: string) => {
  try {
    await useGraphStore.getState().acceptWriteback(id)
    await refreshWriteback()
    const gid = useGraphStore.getState().currentGraphId
    if (gid) await useGraphStore.getState().loadGraph(gid) // 采纳后图已变，刷新画布
  } catch (err) { console.error('[GraphCanvas] accept writeback failed:', err) }
}, [refreshWriteback])

const handleDiscard = useCallback(async (id: string) => {
  try { await useGraphStore.getState().discardWriteback(id); await refreshWriteback() }
  catch (err) { console.error('[GraphCanvas] discard writeback failed:', err) }
}, [refreshWriteback])
```

渲染 `<WritebackPanel items={writebackItems} onAccept={handleAccept} onDiscard={handleDiscard} onNavigate={navigateToNode} onClose={() => setWritebackOpen(false)} />`（navigateToNode 用现有 `eventBus.emit(Events.NAVIGATE_TO_NODE, ...)`）。打开画布时 `refreshWriteback()` 一次以显示角标 N。

- [ ] **Step 3: 三门槛**

Run: `npx tsc --noEmit && npm run lint && npm run test`

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/GraphCanvas.tsx src/renderer/canvas/components/CanvasOverlay.tsx
git commit -m "feat(wiki): 画布菜单「审核队列(N)」入口 + WritebackPanel 接线"
```

---

### Task 8: 顺手修复（M4 断链噪音 + IPC 真实库测试 + LintPanel a11y）

**Files:**
- Modify: `src/main/wiki/graph-lint-service.ts`（M4）
- Modify: `src/main/wiki/__tests__/graph-lint-service.test.ts`
- Modify: `src/main/ipc/__tests__/graph.test.ts`（computeCommunities/lint 真实库集成测试）
- Modify: `src/renderer/components/wiki/LintPanel.tsx`（a11y）
- Modify: `src/renderer/components/wiki/__tests__/LintPanel.test.tsx`

- [ ] **Step 1: M4 — 断链扫描排除 community 页**

`graph-lint-service.ts` 断链检测处：过滤掉 `wikiMeta.specialPage === 'community'` 的页面（其 `[[成员]]` 链接本不落边，是预期）。补测试：含 community 页的图，断链报告不含该页的 `[[成员]]`。

- [ ] **Step 2: IPC 真实库集成测试**

`graph.test.ts` 补 `wiki:computeCommunities`/`wiki:lint` 各一组真实 better-sqlite3 集成测试（建内存库跑 migrate → seed 节点/边 → 调 handler → 断言返回结构）。

- [ ] **Step 3: LintPanel a11y**

可点击行加 `role="button"` `tabIndex={0}` `onKeyDown={(e) => { if (e.key==='Enter'||e.key===' ') onNavigate(nodeId) }}`。`LintPanel.test.tsx` 补键盘交互一例。

- [ ] **Step 4: 三门槛 + Commit**

Run: `npx tsc --noEmit && npm run lint && npm run test`

```bash
git add src/main/wiki/graph-lint-service.ts src/main/wiki/__tests__/graph-lint-service.test.ts src/main/ipc/__tests__/graph.test.ts src/renderer/components/wiki/LintPanel.tsx src/renderer/components/wiki/__tests__/LintPanel.test.tsx
git commit -m "fix(wiki): M4 断链排除 community 页 + IPC 真实库测试 + LintPanel a11y"
```

---

## Self-Review 记录

- **Spec 覆盖**：类型(T1)/schema v8(T1)/repo(T1)/生成(T2)/采纳(T3)/管线接入+开关(T4)/IPC(T5)/store+面板(T6)/画布入口(T7)/顺手修复三项(T8) — 全覆盖。
- **占位符扫描**：T3 测试的 `it` 注释为引导提示，实现者须补全真实断言——已注明字段名以 node-repository 为准。其余步骤含完整代码。
- **类型一致性**：`WritebackItem`/`WritebackKind`/`WritebackStatus`(T1) 在 T2/T3/T5/T6 一致引用；`generate`/`accept` 签名跨任务一致；`findExistingTitles`(T2) 在 T4/T5 复用。
- **已知偏差（实现者须以现网为准）**：`generateId` 前缀形式、`ensureString` 实参顺序、`edgeType` 允许值、`PipelineStage.enabled` 是否同步、graphStore 的 IPC 封装方式——均已在对应步骤注明「以现网为准」。
