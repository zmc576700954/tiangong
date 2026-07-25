# Wiki 图计算 + LLM Ingest + Graph Lint · 设计文档

> 日期：2026-07-25
> 前置任务：[../../tasks/2026-07-23-wiki-link-ingest.md](../../tasks/2026-07-23-wiki-link-ingest.md)（wikilink 全链路 + 规则式 Ingest，已完成）
> 规划来源：记忆 `llm-wiki-stepwise-plan`

## 背景与目标

上一阶段已打通 wikilink 全链路（解析 → 落边 → 反向链接 → 断链检测）与规则式文件导入管线。本阶段在其上叠加三件直接依赖既有地基的能力：

1. **LLM Ingest**：在规则式导入之外增加 LLM 提炼模式，原始资料经 LLM 编译为 wiki 页（含 frontmatter 与建议 wikilink）
2. **Louvain 图计算**：基于 wiki-link 边做社区发现，写回节点 `communityId/communityLevel`，并规则化生成社区 wiki 页
3. **Graph Lint**：聚合断链、孤立节点、社区异常三类问题为 Lint 报告，前端面板呈现，修复全手动

三者在一次实现中完成（纯函数部分各自独立可测，UI 一次性接入）。

## 关键决策（已确认）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 本阶段范围 | LLM Ingest + Louvain + Graph Lint 三者全做 | 功能面成体系，一次到位 |
| Louvain 摘要 | 不做 LLM 摘要，社区页规则化生成 | `communitySummary` 留待后续 LLM 增强阶段 |
| Louvain 运行位置 | 主进程同步计算，不开 Worker Thread | 规模小（wiki 图远小于代码图）；IPC 层已有批量上限约束；Worker 的序列化/生命周期成本不值 |
| Louvain 实现 | 自研 `src/main/wiki/louvain.ts` 纯函数 | 不引第三方图库依赖；可独立单测 |
| LLM Ingest 调用方式 | 复用 `sendPromptViaAgent`（one-shot claude-code，MCP 自动回退） | 沿用既有适配器回退链，不新造 LLM 通路 |
| Graph Lint 修复 | 全部手动，不做自动修复按钮 | 断链修复需要用户判断意图；降低误操作风险 |
| 社区页生成 | 规则化生成，正文含成员 wikilink 列表与统计 | 确定、可测；同时反向补强图连通性 |

## 范围（明确不做）

- LLM 社区摘要（`communitySummary` 字段本阶段不写）
- 4-Signal 相关性、Query Writeback、Deep Research 补缺口、MCP Server 暴露（后续阶段）
- Lint 自动修复 / 一键修复按钮
- Worker Thread 化图计算
- 边的语义类型推断（本阶段 Louvain 仅用 wiki-link 边）

## 组件设计

### 5.1 `src/main/wiki/louvain.ts`（纯函数，无依赖）

```ts
export interface LouvainGraph {
  nodeIds: string[]
  edges: Array<{ source: string; target: string; weight?: number }>
}
export interface CommunityAssignment {
  /** nodeId → 社区 ID（稳定、可复现） */
  communityOf(nodeId: string): string
  /** 所有社区 ID 列表 */
  communities(): string[]
  /** 模块度 Q 值 */
  modularity(): number
}
export function louvain(
  graph: LouvainGraph,
  options?: { resolution?: number; seed?: number },
): CommunityAssignment
```

- 无向图、可带权（wiki-link 边 weight 用 `strength ?? 1`）
- `seed` 固定时结果可复现（测试与 Lint 稳定性需要）
- `resolution` 默认 1.0，控制社区粒度
- 悬空边（引用不存在节点）在构图时过滤，算法不处理

### 5.2 `src/main/wiki/graph-compute-service.ts`

编排 Louvain + 写回 + 社区页差量维护。注入 nodeRepo/edgeRepo，风格同 `IngestService`。

`computeCommunities(graphId): ComputeResult`：

1. 从 edges 表取 `edge_type='wiki-link'` 的边 + 全部 wiki-page 节点，构建 `LouvainGraph`
2. 跑 `louvain()` 得社区划分
3. 写回每个节点 `communityId` / `communityLevel`（`communitySummary` 留空）
   - level 按社区占比分级：0=项目级（成员 >50% 节点）/ 1=模块级（>10%）/ 2=流程级（其余），与既有 `communityLevel` 注释对齐
4. 社区页差量更新：新社区建页、已存在重写正文、消失的社区删页
5. 返回 `ComputeResult`

边界：wiki-link 边数为 0 或节点数 < 2 时不跑算法，返回空结果（`communityCount: 0`），不写回不建页。

### 5.3 `src/main/wiki/llm-ingest-service.ts`

LLM 提炼入口。注入与 IngestService 相同的 nodeRepo/edgeRepo，**复用其同名追加 + 落库语义**，差异仅在内容来源。

`ingestWithLlm(graphId, filePaths, agentRunner, readFile): Promise<IngestResult>`：

1. 逐文件读原文 → 组装提炼 prompt（含输出格式约束 + 图中已有页面标题列表供 wikilink 对齐，标题超 200 截断）
2. 调 `agentRunner(prompt)`（IPC 层注入 `sendPromptViaAgent`，测试时替换为 stub）
3. 解析 LLM 输出为 markdown（标题/frontmatter/正文/建议 wikilink）
4. 走与规则式相同的「同名追加 / 新建 draft / 第二遍统一落边」路径
5. 单文件失败记入 `IngestResult.failed`，不阻塞整批

回退规则：LLM 输出 frontmatter YAML 非法时，以文件名做标题、LLM 原文整体作为 body 追加，记为成功并在 `wikiMeta.ingestWarning` 记录回退原因。

### 5.4 社区 wiki 页（规则生成）

每社区一页，正文规则拼接：

```markdown
---
title: 社区 · <代表词>
specialPage: community
communityId: <id>
---
# 社区 · <代表词>

> 本页由图计算自动生成，请勿手工编辑。

## 成员（<N>）
- [[页面A]]
- [[页面B]]

## 统计
- 内部链接：x · 外部链接：y · 模块度贡献：z
```

代表词取社区内被链接次数最多的页面标题（规则、确定、可测）。

### 5.5 `src/main/wiki/graph-lint-service.ts`

`lint(graphId): LintReport`，只读聚合三类问题：

- **断链**：复用 `WikiLinkService.findDanglingLinks`
- **孤立节点**：无任何 wiki-link 入边/出边的 wiki-page（特殊页除外）
- **社区异常**：单节点社区（疑似游离）、超大社区（>50% 节点，疑似未分化）

附 `stats { nodeCount, edgeCount, communityCount }`。不写库、不缓存、不修复。

### 5.6 IPC 与渲染层

- 新通道：`wiki:computeCommunities`、`wiki:lint`；`wiki:ingestFiles` 增加 `mode: IngestMode` 参数（默认 `'rule'` 保持兼容）
- 渲染层：
  - `WikiImportDialog` 加「LLM 提炼」开关（对应 `mode`）
  - 新增 `LintPanel`，挂在 Wiki 侧栏，列出 `LintIssue`，点击跳转节点；修复全手动
  - 社区页走既有 WikiPageEditor 渲染（specialPage 禁删，规则生成页只读提示）

## 数据流与类型改动

### 6.1 `src/shared/types/graph.ts`

`WikiNodeMeta.specialPage` 增加 `'community'`：

```ts
specialPage?: 'index' | 'log' | 'community'
```

影响面：①禁删逻辑按 `specialPage` 真值判断，社区页自动获得禁删保护；②`ensureSpecialPages` 只认 `index|log`，不受影响。

### 6.2 `src/shared/types/wiki.ts` 新增

```ts
export type IngestMode = 'rule' | 'llm'

export interface LintIssue {
  kind: 'dangling-link' | 'orphan' | 'community-singleton' | 'community-oversized'
  severity: 'info' | 'warning'
  nodeId?: string
  message: string
  hint: string
}
export interface LintReport {
  issues: LintIssue[]
  stats: { nodeCount: number; edgeCount: number; communityCount: number }
}

export interface CommunityInfo {
  id: string
  memberIds: string[]
  size: number
  internalEdges: number
  externalEdges: number
}
export interface ComputeResult {
  communityCount: number
  nodeCount: number
  modularity: number
  communities: CommunityInfo[]
}
```

### 6.3 LLM Ingest 数据流

```
文件原文
  → 组装 prompt（提炼要求 + 输出格式约束 + 已有页面标题列表）
  → sendPromptViaAgent（one-shot claude-code，超时默认 120s/文件）
  → LLM 输出 markdown → parseWikiMarkdown 解析
  → 同名判定（normalizeWikiTitle + 大小写不敏感，与规则式一致）
      ├ 已存在 → 追加（来源分隔线）
      └ 不存在 → 新建 draft 节点（网格布局）
  → 全部处理完 → 第二遍统一 syncNodeLinks
  → IngestResult
```

### 6.4 社区计算数据流

```
edges(wiki-link) + wiki-page 节点
  → 构建无向带权 LouvainGraph（weight = strength ?? 1）
  → louvain()（固定 seed，可复现）
  → 写回 communityId / communityLevel
  → 社区页差量更新（建 / 重写 / 删）
  → ComputeResult
```

### 6.5 Lint 数据流

```
wiki:lint(graphId)
  → findDanglingLinks      → dangling-link
  → 无入边无出边 wiki-page  → orphan（特殊页除外）
  → 节点 communityId       → singleton / oversized
  → LintReport（附 stats）
```

## 错误处理

**LLM Ingest**
- 单文件失败（读文件失败 / Agent 超时 / 输出无法解析）→ 记入 `IngestResult.failed`，不阻塞整批
- Agent 全部不可用（未安装且无 API key）→ 整个调用立即失败，提示改用规则式；不做批量中途降级
- LLM 产生的悬空 wikilink 不入库（沿用既有规则），由 Lint 断链项暴露

**Louvain**
- 边数为 0 或节点数 < 2 → 空结果，不写回不建页
- 悬空边构图时过滤；算法纯函数无 IO

**Graph Lint**
- 只读；graphId 不存在 → 标准 IPC 错误；不缓存

## 测试策略

**纯函数单测（重点）**
- `louvain.ts`：两个三角+桥边 → 2 社区；单链图；空图；带权边影响；固定 seed 可复现；resolution 粒度

**服务层单测（内存 repo + stub agentRunner）**
- `graph-compute-service`：communityId 写回、社区页建/重写/差量删、层级分级、幂等
- `llm-ingest-service`：新建/同名追加/frontmatter 回退/单文件容错/已有标题注入 prompt/第二遍落边
- `graph-lint-service`：四类 issue 与 severity；特殊页不计 orphan

**IPC 层测试**
- `wiki:ingestFiles` mode 默认 `rule` 兼容
- `wiki:computeCommunities` / `wiki:lint` 参数校验 + happy path（真实 better-sqlite3 内存库）

**渲染层**
- `WikiImportDialog` mode 开关传参；`LintPanel` 渲染与点击跳转

**性能约束**
- IPC 批量上限 100 沿用；louvain 对 1000 节点玩具图的完成时间上界断言

**验证门槛（每个 commit 前）**：`npx tsc --noEmit` 零错误、`npm run test` 全绿、`npm run lint` 零警告
