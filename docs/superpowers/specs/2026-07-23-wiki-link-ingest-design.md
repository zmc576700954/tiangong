# Wiki 链接全链路 + 规则式 Ingest 管线 · 设计文档

> 日期：2026-07-23
> 状态：已确认
> 关联：[[llm-wiki-stepwise-plan]]（LLM-Wiki 第一阶段收尾）
> 任务跟踪：[docs/tasks/2026-07-23-wiki-link-ingest.md](../../tasks/2026-07-23-wiki-link-ingest.md)

## 背景

2026-07-09 决策将 LLM-Wiki 理念融入 BizGraph 双图模型。2026-07-23 提交 `4d27db4` 完成了 Wiki 后端地基（markdown 解析、WikiIndexService 特殊页、wiki-page 节点类型、wiki_content/wiki_meta 存储），前端有 WikiPageEditor 接入 NodeEditor。

**当前断点**：

1. **Wikilink 解析链路断裂** — 后端 `wiki:resolveLink` IPC 无前端调用方；WikiPageEditor 用简单正则自行解析，不跳过代码块、不归一化标题、不支持 `[[目标|显示]]` 别名，前后端规则漂移
2. **Wiki 图结构缺失** — wikilink 仅是文本，edges 表无对应关系，无法做反向链接、断链检测、图遍历
3. **Ingest 管线缺失** — 原始资料无法导入编译进图
4. **任务跟踪缺失** — LLM-Wiki 规划无本地文档，会话中断后无法恢复上下文

## 目标

- wikilink 从"文本装饰"变为"图内真实关系"：可跳转、可反查、可检测断链
- 规则式文件导入：markdown/txt 文件批量编译为 wiki-page 节点并自动建立链接边
- 建立任务跟踪文档机制，支持跨会话恢复
- 为后续 Louvain 社区发现、4-Signal 相关性、Graph Lint 打地基

## 非目标（YAGNI）

- 不做 LLM 智能提炼（下一阶段独立 spec）
- 不监听源文件变化（导入是一次性快照）
- 不解析文件间相对路径链接、不支持 docx/pdf
- Wiki 边不在画布上可视化（仅用于关系查询）
- 不做 wiki_links 独立表（复用 edges）

## 架构：WikiLinkService 统一服务

wikilink 的解析、目标解析、落边、反向链接全部收敛到 main 进程单一服务，前端不再自行解析。

### 数据模型

- `EdgeType` 新增 `'wiki-link'`（`src/shared/types/graph.ts:52`）
- Wiki 边 = `edges` 表中 `edge_type='wiki-link'` 的行，复用 `sourceNodeId` / `targetNodeId`，**无表结构变更**
- `GraphEdge.edgeType` 字段已存在（graph.ts:166），序列化/反序列化路径无需改动

### 悬空链接（dangling）策略

wikilink 指向的标题在当前图内不存在时，**不创建边**。悬空状态由 `wiki:parseContent` 实时计算返回（`resolved: false`），不入库。

**理由**：避免"目标页创建后要回扫修复历史悬空边"的脏数据问题；断链检测变为实时解析，单图几百节点规模是毫秒级。

### WikiLinkService

新建 `src/main/services/wiki-link-service.ts`：

```typescript
interface SyncResult {
  added: GraphEdge[]      // 新建的 wiki-link 边
  removed: GraphEdge[]    // 删除的 wiki-link 边
  dangling: string[]      // 未解析的目标标题
}

interface ParsedWikiContent {
  frontmatter: Record<string, unknown>
  title?: string
  links: WikiLinkResolution[]  // targetTitle, displayText?, resolved, nodeId?
}

interface DanglingLink {
  fromNodeId: string
  fromTitle: string
  targetTitle: string
}

class WikiLinkService {
  // 同步某 wiki-page 节点的出边：解析 → 提取 wikilinks →
  // 按标题解析目标 → 与现有 wiki-link 出边 diff → 增删
  syncNodeLinks(nodeId: string): SyncResult

  // 实时解析（不落库），供前端渲染
  parseContent(graphId: string, content: string): ParsedWikiContent

  // 反向链接：谁链了我
  getBacklinks(nodeId: string): GraphNode[]

  // 全图断链扫描（Graph Lint 基础）
  findDanglingLinks(graphId: string): DanglingLink[]
}
```

### 触发时机

- `GraphService.updateNode()`：`wikiContent` 变更时调 `syncNodeLinks()`
- `GraphService.createNode()`：创建带 wikiContent 的节点时调 `syncNodeLinks()`
- 节点删除：复用 edges 级联清理
- `wiki:resolveLink` 保留为兼容通道，内部改调 WikiLinkService

### 画布过滤

`graphStore` 加载 edges 后过滤 `wiki-link` 类型，不进 xyflow edges 状态。Wiki 边仅服务 backlinks / 断链 / 未来图计算。

## Ingest 管线（规则式文件导入）

新建 `src/main/wiki/ingest-pipeline.ts`（纯函数 + 薄服务层）。

### 入口

画布工具栏 / 节点上下文菜单新增「导入 Wiki 页面」，Electron dialog 选择 `.md` / `.txt` / `.markdown`（复用现有 dialog IPC）。

### 流程

```
选择文件 → 逐个读取 → parseWikiMarkdown()
  → 标题：frontmatter.title > 首个 H1 > 文件名（去扩展名）
  → normalizeWikiTitle 归一化后查重（当前图内同标题 wiki-page）
  → 存在 → 追加：body 末尾加 `\n\n---\n> 导入自 <文件名> <日期>\n\n` + 新内容
  → 不存在 → 创建 wiki-page 节点（status: draft，网格布局）
  → 全部创建/更新完成后，统一对每个 touched 节点调 syncNodeLinks()
```

### 关键行为

- **批量先建后链**：N 个文件全部建完节点再统一 sync 边，同批文件 A 的 `[[B]]` 能解析到同批 B
- **单文件失败不阻塞整批**：返回 `IngestResult { created, updated, failed: [{file, error}] }`
- **同名追加而非覆盖**：保留来源痕迹（分隔线标注文件名+日期），避免导入 PRD 更新版时丢失旧内容
- **导入节点 status: draft**：走正常状态机确认流程，不直接 confirmed
- **布局**：从画布中心网格铺开（复用 `layout.ts`）

### 结果反馈

前端 toast + 复用 `ChangeSummaryBadge` 展示创建/更新/失败计数。

## 前端改造

### WikiPageEditor 重写

**删除**：`WIKILINK_RE` 正则、手写 YAML 解析器（`parseYamlInput` / `parseFrontmatter`）。

**改为**：

- 编辑内容防抖 500ms 调 `wiki:parseContent`，后端返回结构化 `ParsedWikiContent`
- **预览页签**：自定义 ReactMarkdown 文本渲染，`[[目标|显示]]` 渲染为内联元素——
  - 已解析：可点击链接，跳转 `onNavigate(nodeId)`
  - 悬空：灰色虚线样式，点击弹「创建页面」确认（createNode + 自动回填标题）
- **Frontmatter 页签**：只读结构化键值表，展示后端解析结果；`specialPage` 等系统字段不可改。**用户失去直接编辑原始 YAML 能力**，换来解析规则唯一（js-yaml）
- **新增 Backlinks 页签**：`wiki:getBacklinks` 展示来源页面，点击跳转

### IPC 变更

```typescript
// src/shared/types/ipc.ts 新增
wiki:parseContent  (graphId, content) → ParsedWikiContent
wiki:getBacklinks  (nodeId) → { id, title }[]
wiki:ingestFiles   (graphId, filePaths) → IngestResult
wiki:findDangling  (graphId) → DanglingLink[]
// 保留兼容
wiki:resolveLink   （内部改调 WikiLinkService）
```

### 渲染逻辑抽纯函数

`ParsedWikiContent → 渲染片段` 的映射抽为纯函数放 `src/renderer/lib/`，配套 vitest。

## 任务跟踪文档机制

新建 `docs/tasks/2026-07-23-wiki-link-ingest.md`，中文，结构：

- 背景与目标（链接到本 spec）
- 当前状态（进行中 / 阻塞 / 完成）
- 任务清单（checkbox + 状态 + 产出 commit hash）
- 决策记录（追加式：日期 + 决定 + 原因）
- 会话恢复指南（当前步骤、下一步、注意事项）

**实践**：每完成一个子任务立即更新并随代码 commit。会话中断后新会话读此文档接续。

## 构建修复

`npm rebuild better-sqlite3` 修复 NODE_MODULE_VERSION 失配（10 个测试文件因此失败），单独 chore commit，不改代码。

## 测试策略

| 层 | 文件 | 内容 |
|---|---|---|
| 纯函数 | `wiki/__tests__/wiki-link-service.test.ts` | syncNodeLinks diff、悬空识别、标题归一化、环形链接 |
| 纯函数 | `wiki/__tests__/ingest-pipeline.test.ts` | 标题优先级、同名追加、批量互链、单文件失败 |
| IPC | `ipc/__tests__/graph.test.ts` 扩充 | 新通道参数校验（复用现有 mock） |
| 服务集成 | `services/__tests__/wiki-index-service.test.ts` 扩充 | 导入后特殊页不受影响、resolveLink 兼容 |
| 前端纯函数 | `renderer/lib/__tests__/` | ParsedWikiContent → 渲染片段映射 |

## 提交顺序

1. `chore: rebuild better-sqlite3 + 任务文档骨架`
2. `feat(wiki): EdgeType 增加 wiki-link + WikiLinkService + syncNodeLinks 接入 GraphService`
3. `feat(wiki): IPC 新通道 + 前端 WikiPageEditor 重写`
4. `feat(wiki): Ingest 管线 + 导入 UI 入口`
5. `docs: 任务文档收尾 + CLAUDE.md 补充 Wiki 机制说明`

## 验证门槛

每个提交前：

- `npx tsc --noEmit` 零错误
- `npm run test` 全绿（rebuild 后 167 个文件）
- `npm run lint` 零警告

## 错误处理

- frontmatter YAML 解析失败：沿用 `WIKI_PARSE_ERROR`（`markdown-utils` 已抛）
- Ingest 单文件失败：收集到 `IngestResult.failed`，不阻塞
- `syncNodeLinks` 目标节点不存在：归入 dangling，不抛错（正常状态）
- IPC 层：沿用 `IpcError` + 路径安全校验（ingestFiles 校验路径在已注册项目根内）

## 后续阶段衔接

本设计为以下规划功能提供地基：

- **Louvain / 4-Signal 图计算**：wiki-link 边作为权重参与
- **Graph Lint**：`findDanglingLinks()` 直接可用
- **Review Queue**：导入的 draft 节点进入确认流程
- **LLM Ingest**：规则式管线的节点创建/落边路径可直接复用，仅替换"解析"环节
