# BizGraph 全面打磨 — Section 4-6 设计文档

> 日期: 2026-06-17
> 状态: 待实施
> 策略: 纵切优先，每领域6个子任务全部实施，增量增强为主
> 依赖: Section 1-3 已完成（EmbeddingService, ContextPipeline, PromptOrchestrator, Store拆分, MessageQueue, SessionRecovery）

---

## Section 4: 思维导图与知识图谱优化

### 4.1 图谱知识关联 (方案A)

**现状**: `GraphMemory.inferRelations()` 用5条启发式规则推断关系。`GraphService.suggestEdges()` 用 SymbolIndex import 发现边。

**改进**:
- 新增 `KnowledgeAssociator` 类，整合3种关联信号：
  1. **代码依赖** (权重0.9) — 复用 `suggestEdges()` 的 SymbolIndex import 发现
  2. **语义相似** (权重0.7) — 调用 `EmbeddingService` 对节点 title+description 生成向量，余弦相似度 >0.6 候选
  3. **变更耦合** (权重0.6) — 从 `memory_items.files_modified` 统计共变频率
- 加权平均 >0.6 才写入图谱边
- `EdgeType` 扩展增加 `'semantic' | 'dependency' | 'co-change'`
- 边的 `strength` 字段存储置信度分数
- 关联可视化：`BizEdge` 根据 `edgeType` 切换线型（semantic=虚线蓝、dependency=实线绿、co-change=点线橙）

**新文件**: `src/main/memory/knowledge-associator.ts`
**修改文件**: `src/shared/types/graph.ts`, `src/main/services/graph-service.ts`, `src/renderer/canvas/BizEdge.tsx`

### 4.2 图谱知识细化 (方案A)

**现状**: `NodeContent` 和 `NodeMetadata` 有结构化字段，但无 per-NodeType schema 验证。

**改进**:
- 新增 `NodeSchemaRegistry` — 为每种 NodeType 定义元数据 schema：
  - module: `{ frameworks, entryPoints, keyFiles, techStack }`
  - process: `{ apiEndpoints, dataFlow, stakeholders, frequency }`
  - feature: `{ acceptanceCriteria, linkedFiles, testCoverage, priority }`
  - bug: `{ severity, reproduction, affectedUsers, fixDeadline }`
- `SchemaValidator` 在 `node:update` IPC handler 写入前校验
- `ProjectScanner` 扫描结果自动填充 schema 字段
- 不增加新 DB 列，利用现有 `metadata` JSON 字段

**新文件**: `src/main/memory/node-schema-registry.ts`
**修改文件**: `src/main/ipc/graph.ts`, `src/main/project-scanner/`

### 4.3 导图与图谱双向同步 (方案B)

**现状**: Canvas 操作通过 IPC 实时写入 DB，反向同步不存在。

**改进**:
- 新增 `GraphSyncService`:
  - **Canvas → GraphMemory**: 监听 `GRAPH_CHANGED` 事件，写入图谱
  - **GraphMemory → Canvas**: `KnowledgeAssociator` 发现新关联时创建建议边（`EdgeContent.suggested: true`），30s 批量推送到 renderer
  - 用户操作优先：suggested 边需确认才变为正式边（确认时清除 suggested 标记）
- 同步策略：Canvas 实时写入；关联发现30s批量推送
- 新 IPC 通道 `graph:suggestedEdges`

**新文件**: `src/main/services/graph-sync-service.ts`
**修改文件**: `src/main/ipc/graph.ts`, `src/renderer/store/graphStore.ts`, `src/renderer/canvas/BizEdge.tsx`

### 4.4 导图索引优化 (方案A)

**现状**: `graphStore` 用数组存储，查找 O(n)。DB 无复合索引。

**改进**:
- **前端**: `graphStore` 内部增加 `nodeIndex: Map<string, GraphNode>` + `nodesByType: Map<NodeType, Set<string>>`，对外通过 selector 暴露数组
- **DB**: 添加复合索引：
  - `idx_nodes_graph_id_type`
  - `idx_nodes_graph_id_status`
  - `idx_chat_threads_adapter_status`
  - `idx_chat_messages_thread_status`
  - `idx_memory_items_project_created`

**修改文件**: `src/renderer/store/graphStore.ts`, `src/main/database.ts`

### 4.5 图谱查询缓存 (方案A)

**现状**: `GraphMemory.traverse()` 每次重建边索引（200条记忆 + O(N²) 推断），无缓存。

**改进**:
- 新增 `QueryCache` LRU 缓存（最多100条），key = `(起点nodeId + 深度 + 关系类型)`
- `traverse()` 调用前查缓存；写入时失效相关条目
- 缓存 TTL 5分钟
- 批量查询接口：`traverseBatch(nodeIds[], options)` 一次查多个节点

**新文件**: `src/main/memory/query-cache.ts`
**修改文件**: `src/main/memory/graph-memory.ts`

### 4.6 导图生成展示 (方案A)

**现状**: MindmapAgent 生成过程无进度反馈，结果直接写入 DB。

**改进**:
- 每阶段通过 EventBus 发送 `GENERATION_PROGRESS` 事件：`{ phase: 'scanning'|'structuring'|'enriching'|'validating', percent, message }`
- `GraphCanvas` 上叠加进度条 + 当前阶段描述
- 预览功能：生成完成先创建 `GraphNode.metadata.preview: true` 标记的半透明节点，用户确认后移除标记
- 分阶段生成：大项目先生成 module 层，确认后继续 process/feature 层
- 预览节点可一键清除（删除 metadata.preview 标记的节点）

**修改文件**: `src/main/ipc/mindmap.ts`, `src/renderer/store/graphStore.ts`, `src/renderer/canvas/GraphCanvas.tsx`, `src/renderer/canvas/BizNode.tsx`

**类型扩展**: `EdgeContent` 增加 `suggested?: boolean`；节点预览用 `metadata.preview` 字段，无需类型变更

---

## Section 5: Agent适配器系统优化

### 5.1 适配器连接速率优化 (方案A)

**现状**: `checkAllInstalled()` 串行执行。无缓存、无延迟加载、无平台预过滤。

**改进**:
- `AdapterRegistry.checkAllInstalled()` 改为 `Promise.allSettled` 并行检测
- 检测结果缓存5分钟（`Map<adapterName, {installed, checkedAt}>`）
- AdapterDescriptor 增加 `lazyDescription?: () => Promise<string>`
- 根据 `process.platform` 预过滤 registry

**修改文件**: `src/main/agent/adapter-registry.ts`, `src/main/adapters/registry.ts`

### 5.2 错误捕捉与处理 (方案A)

**现状**: exit code 仅做日志。SessionRecoveryManager 未被调用。CircuitBreaker 仅在 MCP 服务器。

**改进**:
- `doSendCommand()` 外层 try-catch → 未预期异常转为 `AdapterError`
- Exit code → 自动动作映射（AgentManager sessionEnded 回调）:
  - 137/143: 不重试
  - 1: `SessionRecoveryManager.attemptRecovery()`，重试1次（先 ScopeGuard 回滚）
  - 126/127: 标记不可用，通知安装
  - 其他: 记录日志，通知用户
- CircuitBreaker 提升到 BaseAdapter: 从 McpAdapter 提取为 `AdapterCircuitBreaker` 独立类
- 超时分层: connection 10s / firstByte 30s / execution 5min

**新文件**: `src/main/adapters/circuit-breaker.ts`
**修改文件**: `src/main/adapters/base.ts`, `src/main/adapters/mcp-adapter.ts`, `src/main/agent/agent-manager.ts`

### 5.3 Chat交互效果优化 (方案A)

**现状**: `JsonProtocolHandler` 有 progress/file_change/error 类型但 Chat 面板未充分利用。

**改进**:
- 输出模式识别: 自动分类为 `file_operation | error_report | progress_update | code_change`
- 实时进度: `AgentChatPanel` 根据进度事件渲染进度条
- 输出折叠: >20行自动折叠为摘要
- 中断状态保留: 中止时已解析 file_change 保留在 DiffReviewPanel

**修改文件**: `src/main/adapters/json-protocol.ts`, `src/renderer/components/agent/AgentChatPanel.tsx`, `src/renderer/store/sessionStore.ts`

### 5.4 适配器交互统一API (方案A)

**现状**: `type: 'cli'|'sdk'|'api'` 是唯一能力提示。无运行时能力发现。

**改进**:
- 新增 `AdapterCapability` 枚举: `Resume | Streaming | FileOps | MultiTurn | ScopeGuard | Tools`
- 每个 AdapterDescriptor 增加 `capabilities: AdapterCapability[]` + `fallbackTo?: string`
- `AgentManager.startSession()` 按 capability 路由（如请求 resume 时跳过不支持 resume 的 adapter）

**修改文件**: `src/shared/types/agent.ts`, `src/main/adapters/registry.ts`, `src/main/agent/agent-manager.ts`

### 5.5 适配器请求编排 (方案A)

**现状**: `sendCommand` 直接阻塞，无队列、无去重、无优先级。

**改进**:
- 新增 `RequestQueue`（AgentManager 层）:
  - 每适配器并发上限可配置（默认1），超出排队
  - 去重：相同 nodeId + command 30秒内合并
  - 优先级：user > retry > system
  - AbortController 支持：排队可取消，执行中可中断
- 消息生命周期: queued → preparing → sending → streaming → completed/failed
- 资源感知：检测 os.loadavg()，高负载降低并发

**新文件**: `src/main/agent/request-queue.ts`
**修改文件**: `src/main/agent/agent-manager.ts`

### 5.6 降级回调机制 (方案A)

**现状**: `startSession` 用静态 fallbackOrder。`getHealthiestAdapter()` 从未被调用。

**改进**:
- 动态降级: fallback 迭代中优先调用 `getHealthiestAdapter()` 而非固定顺序
- 能力感知降级: 降级时 EventBus 发送 `ADAPTER_HEALTH_CHANGE`，ChatPanel 显示降级提示条
- 自动恢复: 降级后每60s检测首选 adapter 健康状态
- 手动覆盖: `AdapterPreferences` 增加 `forceAdapter?: string`

**修改文件**: `src/main/agent/agent-manager.ts`, `src/renderer/components/agent/AgentChatPanel.tsx`, `src/renderer/store/adapterStore.ts`

---

## Section 6: 前端界面与用户体验优化

### 6.1 页面渲染性能优化 (方案A)

**现状**: graphStore 数组存储 O(n) 查找。GraphCanvas double-write 模式。零 lazy loading。无 code splitting。

**改进**:
- graphStore 内部 Map 化 + selector 暴露数组视图 + 浅比较
- 消除 double-write: setRfNodes/setRfEdges 移到 useMemo 内直接返回
- BizNode memo 增加 agentStatus/bugCount/status 比较。BizEdge hover 改 CSS-only
- React.lazy: ChatPanel/VerificationPanel/DiffReviewPanel
- manualChunks: reactflow, lucide, xenova-transformers 独立 chunk
- 500+ 节点降级: 隐藏 MiniMap 动画，简化边渲染

**修改文件**: `src/renderer/store/graphStore.ts`, `src/renderer/canvas/GraphCanvas.tsx`, `src/renderer/canvas/BizNode.tsx`, `src/renderer/canvas/BizEdge.tsx`, `src/renderer/App.tsx`, `vite.config.ts`

### 6.2 界面交互动画流畅度 (方案A)

**现状**: 无 enter/exit 动画。completed badge setTimeout 消失。面板宽度无 transition。无 prefers-reduced-motion。

**改进**:
- 节点选中: 150ms CSS transition (border-color, box-shadow, scale)
- 上下文菜单: Popover fade+scale 100ms
- 拖拽: 非选中节点 pointer-events:none + opacity:0.6
- 缩放: zoom<0.5 隐藏节点文本，停止500ms后恢复
- 连接线反馈: 目标节点 animate-pulse 呼吸动画
- completed badge: CSS opacity transition (3s delay)
- prefers-reduced-motion: 全局禁用动画

**修改文件**: `src/renderer/canvas/BizNode.tsx`, `src/renderer/canvas/BizEdge.tsx`, `src/renderer/canvas/GraphCanvas.tsx`, `src/renderer/index.css`

### 6.3 Chat交互体验 (方案A)

**现状**: 无消息虚拟化。553行 monolithic AgentChatPanel。无骨架屏。流式无序列号去重。

**改进**:
- 流式去重: chunk 加 seq，discard seq<=lastSeq
- 骨架屏: shimmer bar + "Agent 正在思考..."
- 错误友好化: 超时/权限/崩溃 → 用户友好文本
- 消息状态指示: 发送/流式/完成/失败图标
- 代码块增强: 语言标识+复制按钮+可选行号
- 输出折叠: >20行自动折叠

**修改文件**: `src/renderer/components/agent/AgentChatPanel.tsx`, `src/renderer/store/messageStore.ts`, `src/renderer/components/agent/ChatMessageList.tsx`

### 6.4 整体样式与主题 (方案A)

**现状**: BizNode/BizEdge 用硬编码 hex。深色模式无 node status 覆盖。无微交互 token。

**改进**:
- 所有颜色迁移到 hsl(var(--xxx))
- 语义 token: --color-agent-running, --color-bug-critical, --color-node-placeholder
- 深色模式: .dark 补充 node status 颜色 + 对比度审计
- 主题切换过渡: 200ms transition on body
- Canvas 主题适配: ReactFlow style prop 用 CSS 变量
- 微交互 token: --duration-fast/normal/slow

**修改文件**: `src/renderer/canvas/BizNode.tsx`, `src/renderer/canvas/BizEdge.tsx`, `src/renderer/index.css`, `src/renderer/canvas/GraphCanvas.tsx`

### 6.5 加载速度优化 (方案A)

**现状**: 零 lazy loading。无 code splitting。无预加载。无 bundle 分析。

**改进**:
- React.lazy + Suspense (fallback=shimmer) for ChatPanel/SettingsPanel/DiffReviewPanel/VerificationPanel
- hover Chat tab 时 prefetch ChatPanel 代码
- rollup-plugin-visualizer (仅 BUILD_ANALYZE=true)
- EmbeddingService 延迟初始化（首次搜索时触发）
- vendor 拆分: reactflow ~200KB, lucide ~50KB, xenova-transformers ~30MB

**修改文件**: `src/renderer/App.tsx`, `vite.config.ts`, `src/main/memory/embedding-service.ts`, `src/main/agent/agent-manager.ts`

### 6.6 页面布局响应式 (方案A)

**现状**: 固定三栏布局。无断点。无折叠。面板宽度不持久化。

**改进**:
- 弹性宽度: Canvas 占剩余空间，面板最小宽度+拖拽
- localStorage 持久化面板宽度+折叠状态
- 面板折叠: 左右面板增加折叠按钮 → 48px 图标栏
- 3个断点:
  - >=1280px: 三栏
  - 1024-1280px: 左面板折叠+右面板抽屉式
  - <1024px: Tab 式布局
- Chat 面板定位: 大屏侧边固定，小屏底部抽屉式 (sliding up)
- Resize divider 改进: grab cursor + 3px宽度 + hover高亮

**修改文件**: `src/renderer/App.tsx`, `src/renderer/hooks/useResizablePanel.ts`, `src/renderer/panels/LeftPanel.tsx`, `src/renderer/panels/RightPanel.tsx`, `src/renderer/components/agent/AgentChatPanel.tsx`, `src/renderer/index.css`

---

## 数据库迁移

与 Section 1-3 的 schema v3 合并，新增：
- `idx_nodes_graph_id_type`, `idx_nodes_graph_id_status` (复合索引)
- `idx_chat_threads_adapter_status`, `idx_chat_messages_thread_status` (复合索引)
- `idx_memory_items_project_created` (复合索引)
- Schema version 递增到 4（Section 4 新增索引独立提交）

## 领域间依赖

```
Section 4 依赖 Section 1 的 EmbeddingService 和 Section 2 的 ContextPipeline
Section 5 对 Section 3/4 有轻依赖（EventBus 事件）
Section 6 依赖前面所有层接口稳定
```

## 新文件总览

| Section | 新文件 | 行数估计 |
|---------|--------|----------|
| 4 | knowledge-associator.ts | ~150 |
| 4 | node-schema-registry.ts | ~120 |
| 4 | graph-sync-service.ts | ~200 |
| 4 | query-cache.ts | ~80 |
| 5 | circuit-breaker.ts | ~80 |
| 5 | request-queue.ts | ~150 |
| 6 | (无新文件，全是修改) | 0 |

**总计新增 ~780 行，修改 ~20 个文件**
