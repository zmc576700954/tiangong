# Query Writeback（会话产物回写 Wiki 图）· 设计文档

> 日期：2026-07-30
> 前置：[2026-07-25-wiki-graph-compute-design.md](2026-07-25-wiki-graph-compute-design.md)（Louvain + LLM Ingest + Graph Lint）
> 路线图：记忆 `llm-wiki-stepwise-plan` 第四阶段

## 背景与目标

LLM-Wiki 的核心理念是「图自我维护」。前三阶段已落地：Wiki 页面 + wikilink 全链路、规则/LLM 双模式 Ingest、Louvain 社区发现、Graph Lint。本阶段补上「Query Writeback」——Agent 会话结束后，把会话产物（决策、发现、新主题）**自动提炼为写回项**，经**人工审核队列**后写进 Wiki 图，形成「会话 → 提炼 → 审核 → 回写 → 图更丰富」的闭环。

记忆系统（`PipelineRunner`）已存在且可插拔，会话结束自动跑 normalize → extract → verify → persist。本设计在其末尾追加一个 **writeback 阶段**，复用已提炼的 `memories`，零额外 LLM 调用（规则提炼），离线可用。

## 关键决策（用户已逐项拍板）

| 决策点 | 结论 |
|---|---|
| 写回内容 | 三种：追加到现有节点、提炼新 Wiki 页面、MemoryItem 转 Wiki 页 |
| 审核机制 | **审核队列**——写回项默认不进图，用户在面板逐条采纳/丢弃 |
| 提炼方式 | **规则提炼**（复用管线 memories + 模板），不走 LLM |
| 队列存储 | **新表** `writeback_items`（schema v8），生命周期清晰 |
| 审核入口 | **画布面板**（复用 LintPanel 模式），菜单加「审核队列(N)」 |
| 采纳落点 | 追加「## 会话日志」小节到目标节点正文末尾 |
| 防重复 | **按会话去重**（sourceSessionId 命中 pending/accepted 则跳过生成） |
| 范围开关 | 全局默认开，**项目单向覆盖**（全局开→项目可关；全局关→项目不可开） |
| 丢弃语义 | 丢弃只出队（标 discarded），不同步删已写入内容 |
| 顺手修复 | M4 社区页断链噪音、IPC 真实库集成测试、LintPanel a11y |

## 架构

```
会话结束 (terminateSession 阶段B，不持锁)
  → PipelineRunner.run(ctx{ projectId=graphId, nodeId, memories, outputs })
  → writeback 阶段（新增，enabled() 判开关）
       规则模板 → writeback_items(status='pending')
                                                      ↓
用户打开画布 → wiki:countWriteback → 菜单「审核队列(N)」
  → WritebackPanel ← wiki:listWriteback(graphId)
  → 采纳 → wiki:acceptWriteback → WritebackService.accept
       ├─ append-log：读节点 content → 幂等合并「## 会话日志」→ GraphService.updateNode（syncNodeLinks 落边）
       └─ new-page：GraphService.createNode(wiki-page) + 连源节点（syncNodeLinks 落边）
  → 丢弃 → wiki:discardWriteback → status='discarded'
```

**关键事实**：`MemoryItem.project_id` 注释即 `graphs.id`——管线上下文直接携带 graphId，writeback 阶段无需反查。采纳走标准 GraphService（IPC `node:update`/`node:create` 的内部等价路径），`syncNodeLinks` 自动处理 wikilink 落边，与阶段二机制零新增。

## 组件拆解

### 主进程

| 组件 | 文件 | 职责 |
|---|---|---|
| writeback 阶段 | 挂进 `PipelineRunner.createDefault()` stage 列表 | 从 `ctx.memories` 用规则模板生成写回项写表；enabled() 判全局/项目开关；失败不阻塞管线 |
| WritebackRepository | `src/main/repositories/writeback-repository.ts` | `writeback_items` CRUD：create / listPending(graphId) / countPending / updateStatus / findBySession |
| WritebackService | `src/main/services/writeback-service.ts` | 规则模板生成、concept 聚类、按会话去重、采纳落点（调 GraphService）、丢弃改状态 |
| IPC 接线 | `src/main/ipc/graph.ts` | 4 个新通道，沿用 createTypedHandle + ensureString |
| DB schema | `src/main/database.ts` | 新表 writeback_items + graphs.writeback_disabled 列，schema v7→v8 |

### 渲染层

| 组件 | 文件 | 职责 |
|---|---|---|
| WritebackPanel | `src/renderer/components/wiki/WritebackPanel.tsx` | 待审队列侧边面板，逐条采纳/丢弃，复用 LintPanel 布局 |
| 画布入口 | `GraphCanvas.tsx` + `CanvasOverlay.tsx` | 菜单「审核队列(N)」，N=pending 数 |
| graphStore | `src/renderer/store/graphStore.ts` | listWriteback / countWriteback / acceptWriteback / discardWriteback |

## 数据流与类型

### WritebackItem（`src/shared/types/wiki.ts` 追加）

```ts
export type WritebackKind = 'append-log' | 'new-page'
export type WritebackStatus = 'pending' | 'accepted' | 'discarded'

export interface WritebackItem {
  id: string                  // writeback_xxx（generateId）
  graphId: string
  kind: WritebackKind
  targetNodeId: string          // 关联节点：append-log=追加目标；new-page=源节点（采纳连边用）。恒非 null
  title: string               // 新页面标题 / 小节标题
  content: string             // 待写入的 markdown 正文
  sourceSessionId: string     // 去重键
  confidence: number          // 0-1，取所取 memories 均值
  status: WritebackStatus
  createdAt: string           // ISO
  resolvedAt: string | null
}
```

### schema v8 DDL（`src/main/database.ts`）

```sql
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
```

- `CURRENT_SCHEMA_VERSION` 7→8。
- 新表走 `migrate()` 内联 DDL + `rebuildTableIfNeeded`，与现有 11 表同机制。
- 项目级覆盖列：`addColumnSafe('graphs','writeback_disabled','INTEGER DEFAULT 0')`（0=跟随全局，1=强制关），与阶段三 community_id 同机制、无损。

### IPC 签名（`src/shared/types/ipc.ts` + preload 白名单）

```ts
'wiki:listWriteback':    (graphId: string) => Promise<WritebackItem[]>  // status='pending'
'wiki:countWriteback':   (graphId: string) => Promise<number>
'wiki:acceptWriteback':  (itemId: string) => Promise<void>
'wiki:discardWriteback': (itemId: string) => Promise<void>
```

均 `ensureString` 校验 + `createTypedHandle`，挂 `registerGraphHandlers`。

### 规则模板（WritebackService 核心）

**append-log 项正文**（追加到目标节点 content 末尾）：

```markdown

## 会话日志 · 2026-07-30 14:32

> 来源：claude-code 会话 · 置信度 0.82

- <memory.title 1>
- <memory.title 2>

<details><summary>详情</summary>

<memory.narrative 拼接，facts 列为子项>

</details>
```

**新页面正文**（多条 memory 共享 concept 且不等于现有节点标题时）：

```markdown
---
title: <概念聚类标题>
---

# <标题>

> 由 Query Writeback 从会话提炼 · 待人工整理

- 源节点：[[<源节点标题>]]
<memory 列表>
```

**生成规则（确定性）**：
1. `memories` 按 confidence 降序，取前 5 条
2. `confidence` = 所取 memories 均值
3. **new-page 触发**：≥2 条 memory 共享同一 concept 且该 concept（经 `normalizeWikiTitle`）不等于现有任何节点标题 → 每个聚类生成 1 个 new-page 项；否则只生成 append-log 项
4. **append-log 目标**：`ctx.nodeId` 对应节点（须存在且非特殊页，否则跳过）
5. **去重**：`findBySession(sourceSessionId)` 已有 pending/accepted → 跳过整个生成

### 采纳落点（WritebackService.accept）

- **append-log**：读目标节点最新 content → 追加段落（若已含同标题小节则跳过写入，幂等）→ GraphService.updateNode 触发 syncNodeLinks
- **new-page**：GraphService.createNode(type='wiki-page', content=模板) + edge:create 连 targetNodeId（源节点）→ syncNodeLinks
- 采纳后 status='accepted', resolvedAt=now

### 与既有机制的衔接

| 既有机制 | 衔接 |
|---|---|
| syncNodeLinks（阶段二） | 采纳走 GraphService，wikilink 自动落边，零新增 |
| wikiMeta.specialPage 禁删 | append-log 目标排除特殊页（index/log/community），避免污染 |
| 社区页「请勿手工编辑」 | new-page 父=源节点，不落在 community 页下 |
| 按会话去重 | findBySession 拦截同会话重复生成 |

## 错误处理

| 场景 | 处理 |
|---|---|
| writeback 阶段抛错 | 管线 stage 隔离——记 result.errors，不阻塞后续阶段、不影响会话终止 |
| ctx.nodeId 为空 / 节点不存在 / 特殊页 | 跳过生成，记 debug 日志 |
| ctx.memories 为空 | 跳过生成 |
| 同会话重复生成 | findBySession 命中 → 跳过（幂等） |
| 采纳时目标节点已删 | 节点真删时关联 writeback_items 随 target_node_id ON DELETE CASCADE 一并清除（队列自动瘦身）；防御上 accept 仍校验节点存在，不存在抛 IpcError |
| 采纳时 content 已含同标题小节 | 跳过写入直接标 accepted（幂等） |
| 写库失败 | DatabaseError，IPC createTypedHandle 统一捕获 |
| 全局关 / 项目关 | writeback 阶段 enabled()=false，整阶段跳过 |
| 图已删 | ON DELETE CASCADE 清孤儿 writeback_items |

## 测试策略

**吸取阶段三 C1 教训：涉及 DB 字段的一律用真实 better-sqlite3 内存库，不用内存 fake repo。**

| 层 | 测试 | 库 |
|---|---|---|
| WritebackRepository | CRUD / listPending 过滤 / findBySession 去重 / updateStatus / 级联删除 | 真实内存库 |
| WritebackService 生成 | 模板输出、concept 聚类触发、confidence 均值、top-5 截断、去重跳过 | fake repo（纯逻辑） |
| WritebackService 采纳 | append-log 追加+幂等、new-page 建页+连边、节点已删报错 | 真实内存库（走真 GraphService + syncNodeLinks 验落边） |
| writeback 阶段 | enabled 开关、memories 空跳过、失败不阻塞管线 | 管线 StageOverride 注入 |
| IPC | 4 通道参数校验 + happy path | 真实内存库 |
| WritebackPanel | 渲染、采纳/丢弃回调、空态、置信度显示 | 组件测试（仿 LintPanel.test） |
| graphStore | 4 个 action 调正确通道 | mock ipc |

## 顺手修复（阶段三遗留）

| 项 | 落法 | 测试 |
|---|---|---|
| M4 社区页断链噪音 | graph-lint-service 断链扫描排除 specialPage='community' 页面 | graph-lint-service 测试补一例 |
| IPC 真实库集成测试 | wiki:computeCommunities / wiki:lint 各补一组真实库集成测试 | 真实内存库 |
| LintPanel a11y | 可点击行加 role="button" tabIndex={0} onKeyDown(Enter/Space) | LintPanel.test 补键盘交互例 |

## 范围之外（YAGNI）

- 不做 LLM 提炼写回内容（规则模板已够用；后续可作为增强）
- 不做自动写回（一律走人工审核队列）
- 不做 Review Queue 的批量采纳/批量丢弃（先单条）
- 不做写回项的编辑后再采纳（先原样采纳/丢弃）
- 不开放 schema v8 之外的其他表变更
