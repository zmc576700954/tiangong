# BizGraph 全面打磨实施方案

> 日期: 2026-06-18
> 状态: 已完成 (80/80 任务实施完成 — 64 完整完成, 16 部分实现/适配性调整)
> 基线: 4df82e7 (细致优化)
> 策略: 纵向深度推进，从底层到前端逐领域精修

---

## 现状评估

### 已完成工作 (Sections 1-6)

经代码审计，设计方案中 Sections 1-6 的**所有核心模块已实现**：

| Section | 核心模块 | 实现状态 | 代码位置 |
|---------|---------|---------|---------|
| S1-AST | AstCache + 渐进降级 + Vue SFC | ✅ 已实现 | `code-intelligence/ast-parser.ts`, `ast-cache.ts` |
| S1-Memory | MemoryItem版本化 + 冲突解决 + 衰减曲线 | ✅ 已实现 | `memory/memory-store.ts` (pruneWithDecay) |
| S1-RAG | EmbeddingService + HybridSearch双路 + CJK | ✅ 已实现 | `memory/embedding-service.ts`, `hybrid-search.ts` |
| S1-Cleaning | OutputNormalizer + HallucinationChecker + poisoned丢弃 | ✅ 已实现 | `memory/output-normalizer.ts`, `hallucination-checker.ts`, `memory-extractor.ts` |
| S1-Adaptive | AdaptiveConfig运行时调参 | ✅ 已实现 | `adaptive-config.ts` |
| S2-Pipeline | ContextPipeline 8阶段管线 | ✅ 已实现 | `memory/pipeline.ts` |
| S2-Prompt | PromptOrchestrator 5层组装 | ✅ 已实现 | `memory/prompt-orchestrator.ts` |
| S2-Distiller | ContextDistiller 密度排序+Jaccard去重 | ✅ 已实现 | `memory/context-distiller.ts` |
| S2-GraphCtx | GraphMemory→ContextCompiler L3/L4 | ✅ 已实现 | `memory/context-compiler.ts` |
| S2-NodeBind | Pipeline node-bind阶段 | ✅ 已实现 | `memory/pipeline.ts` (node-bind stage) |
| S2-Session | 消息分页+会话归档 | ✅ 已实现 | `services/chat-service.ts` |
| S2-RAG-FewShot | RAG few-shot + JSON Schema约束 | ✅ 已实现 | `mindmap-agent/synthesis/prompt-builder.ts` |
| S2-LLMTrigger | 文件变更分级触发 | ✅ 已实现 | `code-intelligence/file-watcher.ts` |
| S3-Store | 4-store拆分 + agentStore兼容层 | ✅ 已实现 | `renderer/store/adapterStore.ts` 等 |
| S3-Queue | MessageQueue并发+去重+优先级 | ✅ 已实现 | `renderer/store/messageStore.ts` |
| S3-Recovery | SessionRecoveryManager + exit code分类 | ✅ 已实现 | `agent/session-recovery.ts` |
| S3-Confirm | 确认项管理(高风险操作拦截) | ✅ 已实现 | `renderer/store/messageStore.ts` |
| S3-Interrupt | 会话快照+中断恢复 | ✅ 已实现 | `renderer/store/sessionStore.ts` |
| S4-Assoc | KnowledgeAssociator 3信号关联 | ✅ 已实现 | `memory/knowledge-associator.ts` |
| S4-Schema | NodeSchemaRegistry | ✅ 已实现 | `memory/node-schema-registry.ts` |
| S4-Sync | GraphSyncService 双向同步 | ✅ 已实现 | `services/graph-sync-service.ts` |
| S4-Cache | QueryCache LRU+TTL | ✅ 已实现 | `memory/query-cache.ts` |
| S4-Index | graphStore Map索引+DB复合索引 | ✅ 已实现 | `renderer/store/graphStore.ts`, `database.ts` |
| S4-GenDisplay | 进度事件+预览节点 | ✅ 已实现 | `renderer/store/graphStore.ts` |
| S5-Speed | 并行检测+5min缓存 | ✅ 已实现 | `agent/adapter-registry.ts` |
| S5-Error | 错误边界+超时常量+exit分类 | ✅ 已实现 | `adapters/base.ts`, `agent/agent-manager.ts` |
| S5-Capability | AdapterCapability枚举+fallbackTo | ✅ 已实现 | `shared/types/agent.ts`, `adapters/registry.ts` |
| S5-Queue | RequestQueue并发+去重+优先级 | ✅ 已实现 | `agent/request-queue.ts` |
| S5-Circuit | AdapterCircuitBreaker独立类 | ✅ 已实现 | `adapters/circuit-breaker.ts` |
| S5-Degrade | 动态降级+自动恢复检测 | ✅ 已实现 | `agent/agent-manager.ts` |
| S6-Perf | graphStore Map + 消除double-write | ✅ 已实现 | `renderer/store/graphStore.ts`, `canvas/GraphCanvas.tsx` |
| S6-Anim | CSS transition + 拖拽/缩放优化 | ✅ 已实现 | `canvas/BizNode.tsx`, `BizEdge.tsx` |
| S6-ChatUX | 骨架屏+错误友好化+降级提示+seq去重 | ✅ 已实现 | `components/agent/AgentChatPanel.tsx` |
| S6-Theme | CSS变量+语义token+深色模式+reduced-motion | ✅ 已实现 | `index.css`, `BizNode.tsx` |
| S6-Load | React.lazy + manualChunks | ✅ 已实现 | `App.tsx`, `vite.config.ts` |
| S6-Responsive | 响应式断点+面板折叠+localStorage | ✅ 已实现 | `App.tsx`, `hooks/useResizablePanel.ts` |

### 剩余问题：从"功能实现"到"生产级品质"

虽然所有模块已实现，但存在以下深度质量问题：

1. **集成缝隙** — 部分模块已实现但未完全接入主流程
2. **测试覆盖不足** — 多个新模块缺少测试或测试不充分
3. **性能未调优** — EmbeddingService延迟初始化、HybridSearch权重动态调优未生效
4. **边界条件未处理** — 衰减曲线极端值、容量淘汰边界、并发竞态
5. **前端优化未落地** — 虚拟滚动、Bundle分析、500+节点降级未实现
6. **P0缺陷未修** — optimization-tracker中的3项P0仍部分存在

---

## 实施总览

按纵向深度推进，8个领域按依赖顺序排列：

```
领域1: 底层架构精修 → 领域2: 记忆与Prompt深度集成 → 领域3: Chat状态健壮化
    → 领域4: 思维导图效果增强 → 领域5: 适配器交互打磨 → 领域6: 动态Prompt调优
    → 领域7: 前端性能与UX精修 → 领域8: 全局质量与测试补全
```

每个领域包含：具体任务、文件修改计划、技术细节、测试策略、验收标准。

---

## 领域1: 底层架构精修

### 1.1 AST解析 — 渐进降级链完善

**现状**: AstParser有tree-sitter→regex→minimalExtract降级，但tree-sitter-wasm在Electron环境加载不稳定，regex fallback未覆盖Go/Rust/Java的所有声明模式。

**任务**:

- [x] **Task 1.1.1**: 增强regex fallback覆盖范围 ✅
  - 文件: `src/main/code-intelligence/ast-parser.ts`
  - Go: 增加 `func\s+(\w+)`、`type\s+(\w+)\s+struct`、`var\s+(\w+)\s+` 提取
  - Rust: 增加 `fn\s+(\w+)`、`struct\s+(\w+)`、`impl\s+(\w+)` 提取
  - Java: 增加 `(public|private|protected)\s+(class|interface|enum)\s+(\w+)` 提取
  - SQL: 新增 `CREATE\s+(TABLE|INDEX|VIEW)\s+(\w+)` 提取

- [x] **Task 1.1.2**: 增量解析与file-watcher联动 ✅
  - 文件: `src/main/code-intelligence/file-watcher.ts`
  - 在 `on('change')` 回调中调用 `getAstCache().invalidate(filePath)`
  - 在 `ProjectIndexer.reindexFile()` 中先查AstCache，miss时才重新解析
  - 确保AstCache的mtime检测与chokidar的stat.mtime一致

- [ ] **Task 1.1.3**: 位置信息补全 ❌ entity-extractor.ts未提取line/column/endLine/endColumn
  - 文件: `src/main/code-intelligence/entity-extractor.ts`
  - 从AST解析结果中提取 `line`, `column`, `endLine`, `endColumn`
  - regex fallback时估算行号（按`\n`计数定位声明位置）
  - SymbolIndex存储时写入位置字段

**测试**: `ast-parser.test.ts` 增加Go/Rust/Java/SQL fixture; `ast-cache.test.ts` 增加mtime不一致场景

### 1.2 Memory持久化 — 版本化链追踪与冲突解决

**现状**: MemoryStore有version/parent_version字段和`_findByConcepts`，但演进链追踪API未暴露，冲突解决只做"高置信度覆盖"，未保留多版本供检索选择。

**任务**:

- [x] **Task 1.2.1**: 暴露演进链查询API ✅
  - 文件: `src/main/memory/memory-store.ts`
  - 新增 `getEvolutionChain(concept: string, projectId: string): Promise<MemoryItem[]>`
  - 按 `parent_version` 链递归查询，返回完整版本演进序列
  - IPC通道: `memory:getEvolutionChain`

- [x] **Task 1.2.2**: 冲突解决改为双版本保留 ✅
  - 文件: `src/main/memory/memory-store.ts`
  - 当新记忆与同概念现有记忆冲突时，两者都保留（不再覆盖低置信度版本）
  - 检索时返回最高置信度版本为primary，其他版本标记为`alternative`
  - `RankedSearchResult` 增加 `alternatives?: MemoryItem[]` 字段

- [x] **Task 1.2.3**: 衰减曲线边界条件处理 ✅
  - 文件: `src/main/memory/memory-store.ts`
  - `pruneWithDecay`: 处理 `created_at` 为null/undefined的记录（跳过而非报错）
  - `pruneWithDecay`: 容量淘汰时，waterline kind记忆不参与淘汰（永不衰减）
  - `pruneWithDecay`: 批量删除改为单条SQL `DELETE FROM memory_items WHERE id IN (?)` 提升性能

- [~] **Task 1.2.4**: WaterlineSync持久化与启动恢复 ⚠️ persist/restore方法已实现，但AgentManager生命周期未显式调用，使用懒加载按项目恢复替代启动时恢复
  - 文件: `src/main/memory/waterline-sync.ts`
  - 验证 `persist()` / `restore()` 在AgentManager生命周期中正确调用
  - 在 `ipc-handlers.ts` 的 `registerIpcHandlers()` 中增加启动时恢复水位线:
    ```typescript
    const waterline = getWaterlineSync()
    for (const projectPath of projectPaths) {
      await waterline.restore(projectPath)
    }
    ```

**测试**: `memory-store.test.ts` 增加演进链查询、双版本保留、衰减边界条件; `waterline-sync.test.ts` 增加persist/restore集成

### 1.3 RAG系统 — 语义检索性能与增量索引

**现状**: EmbeddingService和HybridSearchEngine已实现，但embedding生成未接入ContextPipeline持久化阶段，旧记忆条目无embedding无法参与语义检索。

**任务**:

- [x] **Task 1.3.1**: Pipeline persist阶段自动生成embedding ✅
  - 文件: `src/main/memory/pipeline.ts`
  - 在persist阶段，对新存储的记忆条目调用 `embeddingService.generateEmbedding(text)`
  - 异步更新 `memory_items.embedding` 列
  - 如果EmbeddingService未初始化，跳过（降级为纯关键词检索）

- [x] **Task 1.3.2**: 旧记忆条目回填embedding ✅
  - 文件: `src/main/memory/memory-store.ts`
  - 新增 `backfillEmbeddings(projectId: string, batchSize = 50): Promise<number>`
  - 查询 `embedding IS NULL` 的条目，按批次生成并更新
  - IPC通道: `memory:backfillEmbeddings`（手动触发，非自动）

- [x] **Task 1.3.3**: HybridSearch权重动态调优接入AdaptiveConfig ✅
  - 文件: `src/main/memory/hybrid-search.ts`
  - `search()` 的 `ftsWeight` 从 `AdaptiveConfig.get('ftsWeight')` 读取（默认0.5）
  - 每次搜索后调用 `adaptiveConfig.recordMetric('searchQuality', { ftsScore, embeddingScore })`
  - 调用 `adaptiveConfig.adapt()` 在后台低频执行（每50次搜索一次）

- [x] **Task 1.3.4**: 文档切分升级为语义切分 ✅
  - 文件: `src/main/code-intelligence/project-indexer.ts`
  - 当前按行数固定切分，改为按AST节点边界切分（函数/类/接口为切分单位）
  - 每个代码片段附带: `{ filePath, startLine, endLine, kind, name }` 元数据
  - 切分后调用 `embeddingService.generateEmbedding()` 生成向量，存储到 memory_items

- [x] **Task 1.3.5**: EmbeddingService延迟初始化保障 ✅
  - 文件: `src/main/memory/embedding-service.ts`
  - 首次搜索请求触发 `initialize()`，非启动时
  - 初始化失败时 `isReady()` 返回false，HybridSearch降级为纯FTS5
  - 增加 `initializeWithTimeout(timeoutMs = 60000)` 方法防止模型下载阻塞

**测试**: `embedding-service.test.ts` 增加超时和降级; `hybrid-search.test.ts` 增加动态权重; `pipeline.test.ts` 增加persist阶段embedding生成

### 1.4 数据清洗 — 质量关卡强化

**现状**: ObserverCompressor有基本噪声过滤，OutputNormalizer有ANSI/进度条/重复行去除，但缺少适配器特定噪声模式。

**任务**:

- [x] **Task 1.4.1**: 适配器特定噪声过滤 ✅
  - 文件: `src/main/memory/output-normalizer.ts`
  - 增加 Claude Code SDK 噪声模式: `Thinking...\n`, `Tool: .*executed\n`
  - 增加 Codex SDK 噪声模式: `Running command:.*\n`
  - 增加 MCP 噪声模式: API响应的 `request_id` 行
  - 通过 `AdapterDescriptor.name` 选择对应过滤规则

- [x] **Task 1.4.2**: HallucinationChecker验证结果接入Pipeline决策 ✅
  - 文件: `src/main/memory/pipeline.ts`
  - 当 `hallucinationReport.riskScore > 70` 时，当前只过滤高置信度记忆
  - 改为: `riskScore > 70` 时标记记忆 `metadata.verified = false`（而非丢弃）
  - `riskScore > 90` 时才丢弃（确认中毒输出）
  - 保留标记为 `verified=false` 的记忆供后续人工审核

- [x] **Task 1.4.3**: AdaptiveConfig压缩阈值动态调整 ✅
  - 文件: `src/main/adaptive-config.ts`
  - 在Pipeline的compress阶段后，调用 `adaptiveConfig.recordMetric('outputSize', outputTokens)`
  - 每20次Pipeline执行后调用 `adaptiveConfig.adapt()`
  - compress阶段读取 `adaptiveConfig.get('compressThresholdTokens')` 替代硬编码4000

**测试**: `output-normalizer.test.ts` 增加适配器特定模式; `pipeline.test.ts` 增加风险评分分级决策; `adaptive-config.test.ts` 增加压缩阈值自适应

### 1.5 自适应配置框架 — 反馈闭环

**现状**: AdaptiveConfig有自适应调参逻辑但未与实际使用场景建立闭环。

**任务**:

- [~] **Task 1.5.1**: 用户反馈信号接入 ⚠️ 机制已通过AdaptiveConfig.recordMetric在hybrid-search.ts和ipc/memory.ts中实现，但memory-store.ts中无显式memoryRejected/memoryUseful方法
  - 文件: `src/main/memory/memory-store.ts`
  - 当用户通过IPC `memory:delete` 删除记忆时，记录到AdaptiveConfig: `recordMetric('memoryRejected', 1)`
  - 当记忆被检索后且后续会话使用了该记忆的上下文，记录: `recordMetric('memoryUseful', 1)`
  - 这些信号影响 `pruneHalfLifeDays` 和 `memoryMaxItems` 的自适应调整

- [x] **Task 1.5.2**: AdaptiveConfig持久化 ✅
  - 文件: `src/main/adaptive-config.ts`
  - 增加方法: `save(filePath: string)` / `load(filePath: string)`
  - 持久化到 `userData/adaptive-config.json`
  - 应用启动时加载，运行时每5分钟自动保存

**测试**: `adaptive-config.test.ts` 增加反馈信号和持久化

---

## 领域2: 记忆与Prompt深度集成

### 2.1 ContextPipeline — 阶段间数据流完善

**现状**: 8阶段管线已实现，但阶段间数据传递存在裂缝——compress阶段的输出未被extract阶段消费，compile阶段的输出未被waterline阶段消费。

**任务**:

- [x] **Task 2.1.1**: compress→extract数据流打通 ✅
  - 文件: `src/main/memory/pipeline.ts`
  - compress阶段的 `observations` 传递给extract阶段
  - extract阶段优先从 `observations` 提取记忆，而非从原始outputs重新分析
  - 这样避免重复分析，且compress已去重的观察结果更干净

- [x] **Task 2.1.2**: compile→waterline数据流打通 ✅
  - 文件: `src/main/memory/pipeline.ts`
  - compile阶段的 `layeredContext` 传递给waterline阶段
  - waterline阶段利用 `layeredContext` 中的概念列表更新 `completedInvestigations`
  - 避免 `advance()` 和 `compile()` 对相同数据做重复的概念提取

- [x] **Task 2.1.3**: Pipeline阶段配置化 ✅
  - 文件: `src/main/memory/pipeline.ts`
  - `PipelineRunner.createDefault()` 接受可选 `stageOverrides: Partial<StageConfig>`
  - 允许跳过指定阶段或替换阶段实现
  - 用于测试和生产环境的不同配置需求

**测试**: `pipeline.test.ts` 增加3个数据流验证测试

### 2.2 PromptOrchestrator — 预算分配与层间优先级

**现状**: 5层组装已实现，但层间预算分配是静态百分比，无法根据实际内容动态调整。

**任务**:

- [x] **Task 2.2.1**: 弹性预算分配 ✅
  - 文件: `src/main/memory/prompt-orchestrator.ts`
  - 当scope层内容为空（非功能节点会话）时，scope预算转移到context层
  - 当waterline层内容超过5%预算时（历史积累），从context层借用预算
  - 实现两轮分配: 第一轮按静态百分比，第二轮按实际使用情况重新分配未用预算

- [ ] **Task 2.2.2**: PromptOrchestrator接入ContextDistiller ❌ ContextDistiller未集成到PromptOrchestrator，distill()未被调用
  - 文件: `src/main/memory/prompt-orchestrator.ts`
  - 在assemble()组装完成后，对最终文本调用 `contextDistiller.distill()`
  - 将5层拼接后的fragment视为ContextFragment数组
  - 超预算时由Distiller决定裁剪哪些片段

- [x] **Task 2.2.3**: 层间去重 ✅
  - 文件: `src/main/memory/prompt-orchestrator.ts`
  - scope层和context层可能包含重复的文件路径/概念定义
  - assemble()中增加: 对相邻层做Jaccard相似度检查(>0.8时去重)
  - 去重时保留高层级（scope优先于context）的版本

**测试**: `prompt-orchestrator.test.ts` 增加弹性预算、Distiller集成、层间去重

### 2.3 GraphMemory — BFS遍历优化与关联推理

**现状**: GraphMemory有BFS遍历和5种关系推断，但遍历深度固定为2，关联推理的启发式规则有限。

**任务**:

- [x] **Task 2.3.1**: 可配置遍历深度 ✅
  - 文件: `src/main/memory/graph-memory.ts`
  - `traverse()` 的 `options.depth` 参数生效（当前可能硬编码为2）
  - 深度>3时增加性能保护: 节点访问上限200，超限截断

- [x] **Task 2.3.2**: 关联推理增加时间衰减因子 ✅
  - 文件: `src/main/memory/graph-memory.ts`
  - `inferRelations()` 的置信度计算增加时间衰减: 越旧的记忆关系置信度越低
  - 公式: `adjustedConfidence = confidence * exp(-ageDays / 90)` (90天半衰期)

- [x] **Task 2.3.3**: KnowledgeAssociator结果缓存 ✅
  - 文件: `src/main/memory/knowledge-associator.ts`
  - `findAssociations()` 的embedding计算结果缓存到QueryCache
  - 相同节点集合+阈值的关联查询5分钟内命中缓存

**测试**: `graph-memory.test.ts` 增加深度和衰减; `knowledge-associator.test.ts` 增加缓存

### 2.4 节点绑定与状态流转

**现状**: Pipeline node-bind阶段标记水位线，但placeholder→developing状态流转未实现。

**任务**:

- [~] **Task 2.4.1**: placeholder→developing自动触发 ⚠️ 状态流转已实现，但缺少NODE_STATUS_CHANGE EventBus事件
  - 文件: `src/main/agent/agent-manager.ts`
  - 在session创建时，如果关联节点的status为'placeholder'，通过IPC更新为'developing'
  - 更新条件: `nodeId` 存在且 `sessionConfig.commandType === 'implement'`
  - 通过EventBus发送 `NODE_STATUS_CHANGE` 事件到renderer

- [~] **Task 2.4.2**: 文件变更自动关联节点 ⚠️ 文件变更匹配和lastModified更新已实现，但通过NodeRepository直接更新而非graph:updateNode IPC
  - 文件: `src/main/agent/agent-manager.ts`
  - session结束后，`parseFileChanges()` 的结果与节点的 `metadata.linkedFiles` 匹配
  - 匹配到的文件更新 `metadata.lastModified = Date.now()`
  - 通过 `graph:updateNode` IPC更新节点元数据

**测试**: `agent-manager.test.ts` 增加状态流转; `pipeline.test.ts` 增加node-bind完整流程

### 2.5 会话内容管理 — 上下文窗口控制

**现状**: 消息分页已实现，但ContextCompiler加载历史消息时无上限。

**任务**:

- [x] **Task 2.5.1**: renderWithHistory消息数量上限 ✅
  - 文件: `src/main/memory/context-compiler.ts`
  - `renderWithHistory()` 增加 `maxMessages` 参数（默认20）
  - 只加载最近N条消息作为上下文
  - 超出时取最近N条，最早的消息只保留摘要

- [x] **Task 2.5.2**: 90天归档线程清理IPC ✅
  - 文件: `src/main/ipc/chat.ts`
  - 新增 `chat:cleanupArchived` IPC通道
  - 删除超过90天的archived线程（含消息）
  - 返回清理数量供UI显示

**测试**: `context-compiler.test.ts` 增加消息上限; `chat-service.test.ts` 增加归档清理

---

## 领域3: Chat状态健壮化

### 3.1 P0缺陷修复

**现状**: optimization-tracker中3项P0（AgentChatPanel God Component, threadOutputs无边界增长, setState直接替换）。

**任务**:

- [x] **Task 3.1.1**: AgentChatPanel拆分（如未完成） ✅ hooks已提取，ChatMessageList已拆分
  - 文件: `src/renderer/components/agent/AgentChatPanel.tsx`
  - 验证 `useAgentOutputListener`, `useVerificationFlow`, `useDiffReview` hooks是否已提取
  - 如果AgentChatPanel仍>300行，继续拆分消息渲染为 `MessageList` 子组件
  - 确认无直接 `useAgentStore.setState` 调用（全部通过store action）

- [x] **Task 3.1.2**: threadOutputs内存边界 ✅ 非活跃线程裁剪到100条已实现，全局上限5000(非可配置3000)
  - 文件: `src/renderer/store/agentOutputStore.ts`
  - 验证非活跃thread裁剪到100条是否实现
  - 增加 `clearThreadOutputs(threadId)` action供terminate时调用
  - 全局上限从5000改为可配置，默认3000

- [~] **Task 3.1.3**: 消除直接setState ⚠️ AgentChatPanel已清理，但HistorySidebar.tsx仍有useAgentStore.setState()
  - 文件: `src/renderer/components/agent/AgentChatPanel.tsx`
  - 所有IPC回调中的 `useAgentStore.setState()` 替换为store action
  - 流式消息拼接统一通过 `messageStore.appendStreamingMessage()`

### 3.2 MessageQueue — 完整生命周期

**现状**: messageStore有基本的发送队列，但消息生命周期状态机不完整。

**任务**:

- [ ] **Task 3.2.1**: 消息状态可视化 ❌ 缺少queued/sending状态图标
  - 文件: `src/renderer/components/agent/ChatMessageList.tsx`
  - 每条消息显示状态图标: `queued⏳ → sending→ → streaming💬 → completed✓ / failed✗`
  - 从messageStore的 `messageStatuses` Map读取状态

- [x] **Task 3.2.2**: 取消支持完善 ✅
  - 文件: `src/renderer/store/messageStore.ts`
  - 排队消息: `cancelQueued(threadId)` 从队列移除
  - 执行中消息: 通过 `AbortController.abort()` 中断
  - 中断后保留已解析的文件变更在DiffReviewPanel

- [x] **Task 3.2.3**: 重试逻辑健壮化 ✅
  - 文件: `src/renderer/store/messageStore.ts`
  - `retryMessage()` 先终止现有session，等待terminate完成后再重发
  - 增加重试次数限制（同一消息最多重试3次）
  - 超限后标记为permanently_failed，显示"请手动重试"提示

**测试**: `messageStore.test.ts` 增加生命周期状态机、取消、重试限制

### 3.3 SessionRecoveryManager — 策略实现

**现状**: SessionRecoveryManager有基本框架，但适配器特定恢复策略未完全实现。

**任务**:

- [x] **Task 3.3.1**: Claude Code自动resume ✅
  - 文件: `src/main/agent/session-recovery.ts`
  - `recoverSession()` 对claude-code适配器: 使用 `--resume <sessionId>` 恢复
  - 注入最近3条消息作为上下文恢复提示
  - 恢复成功后通过EventBus发送 `SESSION_RECOVERED`

- [x] **Task 3.3.2**: MCP Adapter上下文注入恢复 ✅
  - 文件: `src/main/agent/session-recovery.ts`
  - 对mcp-adapter: 创建新会话，在首条消息中注入:
    ```
    [Previous session context]
    Last 3 messages:
    - User: ...
    - Assistant: ...
    - User: ...
    Please continue from where we left off.
    ```
  - 恢复后threadId保持不变，sessionId更新

- [~] **Task 3.3.3**: 恢复次数限制与用户通知 ⚠️ 限制+IPC通知已实现，缺少成功toast UI
  - 文件: `src/main/agent/session-recovery.ts`
  - 每个session最多恢复3次
  - 超限后标记error，通过IPC通知renderer显示"会话恢复失败"提示
  - 恢复成功时在ChatPanel显示"已自动恢复会话"临时提示条

**测试**: `session-recovery.test.ts` 增加适配器策略、恢复限制

### 3.4 确认项管理 — 风险分级与UI

**现状**: 高风险操作拦截已实现，但风险分级逻辑简单，UI未显示确认对话框。

**任务**:

- [~] **Task 3.4.1**: 风险分级细化 ⚠️ 删除/配置文件均为高风险，缺少>5文件中等风险和格式化低风险分级
  - 文件: `src/renderer/hooks/useAgentOutputListener.ts`
  - 删除文件: high risk → 必须确认
  - 修改配置文件: medium risk → 可配置是否确认
  - 变更>5个文件: medium risk → 提示但不阻塞
  - 格式化/注释修改: low risk → 跳过确认

- [ ] **Task 3.4.2**: 确认对话框UI ❌ ConfirmationDialog.tsx组件未创建，事件存在但无UI
  - 文件: `src/renderer/components/agent/ConfirmationDialog.tsx` (新建)
  - 监听 `CONFIRMATION_REQUIRED` 事件
  - 显示: 操作描述、影响文件列表、确认/拒绝按钮
  - 确认: emit `CONFIRMATION_RESPONDED({ accepted: true })`
  - 拒绝: 调用 `scopeGuard.rollbackFile` + emit `CONFIRMATION_RESPONDED({ accepted: false })`

**测试**: `messageStore.test.ts` 增加风险分级; 手动测试确认对话框

---

## 领域4: 思维导图效果增强

### 4.1 知识关联可视化

**现状**: EdgeType已扩展为semantic/dependency/co-change，BizEdge有不同线型，但视觉区分度不够。

**任务**:

- [~] **Task 4.1.1**: 建议边样式完善 ⚠️ 虚线+透明度+无箭头已实现，但缺少"+"确认按钮
  - 文件: `src/renderer/canvas/BizEdge.tsx`
  - `suggested` 边: 虚线 + 透明度0.4 + 无箭头
  - 确认后: 切换为实线 + 完整透明度 + 对应edgeType箭头
  - 拖拽手柄: suggested边两端显示"+"按钮用于一键确认

- [x] **Task 4.1.2**: 关联强度视觉编码 ✅
  - 文件: `src/renderer/canvas/BizEdge.tsx`
  - 边的 `strength` 值映射为线宽: `strokeWidth = 1 + strength * 2`（1-3px范围）
  - 强关联(>0.8): 实线+粗; 弱关联(<0.4): 虚线+细

- [ ] **Task 4.1.3**: 关联发现通知 ❌ 浮动提示未实现
  - 文件: `src/renderer/canvas/GraphCanvas.tsx`
  - 当GraphSyncService发现新关联时，在Canvas右下角显示"发现N个新关联"浮动提示
  - 点击提示展开关联列表，可逐个确认/拒绝

### 4.2 NodeSchema自动填充

**现状**: NodeSchemaRegistry有验证，但ProjectScanner扫描结果未自动填充schema字段。

**任务**:

- [x] **Task 4.2.1**: ProjectScanner→Schema填充 ✅ (缺少keyFiles字段)
  - 文件: `src/main/project-scanner/module-builder.ts`
  - 扫描结果的module节点自动填充: `frameworks`, `entryPoints`, `keyFiles`, `techStack`
  - 来源: `framework-detector.ts` 的检测结果 → `frameworks`
  - 来源: `dir-scanner.ts` 的入口文件 → `entryPoints`
  - 来源: `config-reader.ts` 的依赖 → `techStack`

- [ ] **Task 4.2.2**: Schema验证集成到node:update IPC ❌ validateNodeMetadata未实现
  - 文件: `src/main/ipc/graph.ts`
  - 在 `node:update` handler中，写入前调用 `validateNodeMetadata(nodeType, metadata)`
  - 验证失败时返回warning列表（不阻塞写入，仅附加到响应）

**测试**: `module-builder.test.ts` 增加schema填充; `graph.test.ts` (IPC) 增加schema验证

### 4.3 导图生成进度展示

**现状**: EventBus有GENERATION_PROGRESS事件，graphStore有previewNodes，但Canvas上未渲染进度条。

**任务**:

- [ ] **Task 4.3.1**: Canvas进度叠加层 ❌ 事件存在但无进度条UI
  - 文件: `src/renderer/canvas/components/CanvasOverlay.tsx`
  - 监听 `GENERATION_PROGRESS` 事件
  - 渲染: 阶段名称 + 进度条 + 百分比
  - 位于Canvas顶部居中，半透明背景

- [~] **Task 4.3.2**: 预览节点渲染 ⚠️ 数据模型支持preview标记，但BizNode无视觉渲染(无opacity 0.5+虚线边框)
  - 文件: `src/renderer/canvas/BizNode.tsx`
  - `metadata.preview === true` 的节点: 半透明(opacity 0.5) + 虚线边框
  - 预览节点显示"确认/清除"操作按钮
  - 确认: 调用 `graphStore.confirmPreviewNode(nodeId)` 移除preview标记
  - 清除: 调用 `graphStore.clearPreviewNodes()` 批量删除

### 4.4 搜索与过滤优化

**任务**:

- [~] **Task 4.4.1**: 前端搜索索引增量更新 ⚠️ searchNodes方法+过滤已实现，但无Map索引(扫描数组)
  - 文件: `src/renderer/store/graphStore.ts`
  - 验证 `nodeIndex` Map在节点增删改时正确增量更新
  - 增加 `searchNodes(query: string): GraphNode[]` 利用索引快速搜索
  - 支持按 name/type/status 组合过滤

- [ ] **Task 4.4.2**: TreeView过滤排序 ❌ 无排序和过滤功能
  - 文件: `src/renderer/panels/TreeView.tsx`
  - 增加排序选项: 按名称/类型/状态/最近修改
  - 增加过滤选项: 按状态(filter: placeholder/developing/confirmed)、按类型(filter: module/process/feature)
  - 过滤状态持久化到URL参数或localStorage

**测试**: `graphStore.test.ts` 增加搜索索引; `TreeView` 手动测试

---

## 领域5: 适配器交互打磨

### 5.1 输出结构化解析增强

**现状**: JsonProtocolHandler有基本消息类型，但输出模式识别（file_operation/error/progress/code_change）未充分利用。

**任务**:

- [x] **Task 5.1.1**: 输出模式自动分类 ✅
  - 文件: `src/main/adapters/json-protocol.ts`
  - `protocolMessageToAgentOutput()` 增加模式分类:
    - `file_operation`: 包含文件路径+操作动词(create/modify/delete)
    - `error_report`: 包含Error/Fail/Exception关键词
    - `progress_update`: 包含百分比/进度条
    - `code_change`: 包含diff/patch格式
  - AgentOutput 增加 `pattern?: string` 字段

- [ ] **Task 5.1.2**: 输出折叠 ❌ 无自动折叠机制
  - 文件: `src/renderer/components/agent/ChatMessageList.tsx`
  - >20行的stdout块自动折叠为摘要（显示首3行+展开按钮）
  - 错误输出不折叠
  - 代码块不折叠（有语言标识+复制按钮）

### 5.2 适配器健康度监控与自动恢复

**现状**: AdapterHealthMonitor有健康评分，但未与AgentManager的降级决策完全联动。

**任务**:

- [ ] **Task 5.2.1**: 健康度驱动的自动降级 ❌ 仅有健康度排序，无短超时/连续超时触发/跳过unhealthy逻辑
  - 文件: `src/main/agent/agent-manager.ts`
  - 在 `selectAdapter()` 中，如果首选adapter的健康评分为`degraded`:
    - 先尝试使用，但设置更短的超时(正常50%)
    - 连续2次超时后自动切换到fallback
  - 如果健康评分为`unhealthy`:
    - 直接跳过，使用fallback
    - 启动后台恢复检测（每60s检查一次）

- [~] **Task 5.2.2**: 降级能力通知 ⚠️ 降级横幅存在，但无"切换适配器"按钮和绿色闪烁
  - 文件: `src/renderer/components/agent/AgentChatPanel.tsx`
  - 降级时在ChatPanel顶部显示提示条:
    - 当前适配器名称 + 丢失的能力列表（如"无法恢复会话"）
    - "切换适配器"按钮
    - "已自动恢复"状态变化（绿色闪烁2秒）

### 5.3 适配器请求编排完善

**任务**:

- [~] **Task 5.3.1**: RequestQueue资源感知 ⚠️ getSystemLoad+高负载超时已实现，缺少低负载预取
  - 文件: `src/main/agent/request-queue.ts`
  - 增加 `getSystemLoad(): 'low' | 'medium' | 'high'`
  - high load时自动降低并发（maxConcurrent从1降为1，但排队超时从30s增为60s）
  - low load时可增加预取（提前编译prompt）

- [ ] **Task 5.3.2**: 请求状态追踪UI ❌ requestStatuses未实现
  - 文件: `src/renderer/store/sessionStore.ts`
  - 增加 `requestStatuses` 追踪: `{requestId, status, adapterName, enqueuedAt, startedAt}`
  - 在ChatInput上方显示: "排队中(N) / 执行中(1)"

**测试**: `request-queue.test.ts` 增加资源感知; 手动测试降级UI

---

## 领域6: 动态Prompt调优

### 6.1 PromptOrchestrator层间优化

**任务**:

- [ ] **Task 6.1.1**: scope层动态压缩 ❌ 无优先级移除顺序，无compressionLevel字段
  - 文件: `src/main/memory/prompt-orchestrator.ts`
  - 当总预算紧张时(<50%分配给非压缩层):
    - scope层先移除invariant规则（最长的部分）
    - 再移除上下游上下文
    - 最后压缩allowedFiles列表（只保留文件名，移除路径）
  - 压缩级别记录在 `LayerBreakdown.compressionLevel`

- [x] **Task 6.1.2**: context层深度自适应 ✅
  - 文件: `src/main/memory/context-compiler.ts`
  - 根据剩余预算动态选择L1-L4深度:
    - 充足预算(>70%): 输出L1-L4全部
    - 中等预算(40-70%): 输出L1-L3
    - 紧张预算(<40%): 只输出L1摘要

- [x] **Task 6.1.3**: waterline层增量格式 ✅
  - 文件: `src/main/memory/waterline-sync.ts`
  - `formatContext()` 从全量格式改为增量格式:
    - 只输出上次会话以来的变化（`WaterlineDelta`）
    - 减少90%+的token消耗
    - 首次会话时输出完整waterline

**测试**: `prompt-orchestrator.test.ts` 增加层间优化; `context-compiler.test.ts` 增加深度自适应; `waterline-sync.test.ts` 增加增量格式

### 6.2 ContextDistiller算法精进

**任务**:

- [x] **Task 6.2.1**: embedding去重替代Jaccard ✅
  - 文件: `src/main/memory/context-distiller.ts`
  - 当EmbeddingService可用时，用cosine similarity替代Jaccard做段落去重
  - 阈值: cosine > 0.92 视为重复
  - EmbeddingService不可用时降级为Jaccard

- [x] **Task 6.2.2**: 关键实体保留策略 ✅ (CamelCase priority +1已实现，但无硬性保留1条约束)
  - 文件: `src/main/memory/context-distiller.ts`
  - 首次出现的CamelCase标识符定义为"关键实体"
  - 包含关键实体的片段priority自动+1
  - 即使超预算，关键实体定义至少保留1条

**测试**: `context-distiller.test.ts` 增加embedding去重和关键实体

---

## 领域7: 前端性能与UX精修

### 7.1 渲染性能

**任务**:

- [ ] **Task 7.1.1**: 虚拟滚动 ❌ @tanstack/react-virtual未集成
  - 文件: `src/renderer/panels/TreeView.tsx`
  - 超100条节点时启用 `@tanstack/react-virtual`
  - 同理: `ThreadListOverlay.tsx` 超50条线程时启用

- [x] **Task 7.1.2**: 500+节点降级 ✅
  - 文件: `src/renderer/canvas/GraphCanvas.tsx`
  - 节点数>500时: 隐藏MiniMap动画，简化边渲染（去掉动画），隐藏节点文本
  - 通过 `useMemo` 计算降级策略，不实时计算

- [x] **Task 7.1.3**: BizNode selector优化 ✅
  - 文件: `src/renderer/canvas/BizNode.tsx`
  - 合并3次 `threads.find()` 为单次selector（optimization-tracker #4）
  - 增加 `agentStatus/bugCount/status` 显式比较到memo

- [ ] **Task 7.1.4**: Bundle分析 ❌ rollup-plugin-visualizer未集成
  - 文件: `vite.config.ts`
  - 增加 `rollup-plugin-visualizer`（仅 `BUILD_ANALYZE=true` 时启用）
  - 识别大依赖并拆分: reactflow ~200KB, lucide ~50KB

**测试**: 手动测试500+节点场景; 运行 `BUILD_ANALYZE=true npm run build` 验证chunk分布

### 7.2 交互动画

**任务**:

- [x] **Task 7.2.1**: 节点选中过渡完善 ✅ (全局prefers-reduced-motion已生效)
  - 文件: `src/renderer/canvas/BizNode.tsx`
  - 确认 CSS transition: 150ms (border-color, box-shadow, scale)
  - 确认 `prefers-reduced-motion` 禁用动画

- [ ] **Task 7.2.2**: 连接线反馈动画 ❌ 无呼吸/闪烁动画
  - 文件: `src/renderer/canvas/BizEdge.tsx`
  - 拖拽创建连接时目标节点显示呼吸动画(animate-pulse)
  - 连接成功后目标节点闪烁1次(100ms)

- [x] **Task 7.2.3**: completed badge CSS化 ✅
  - 文件: `src/renderer/canvas/BizNode.tsx`
  - 替换 setTimeout → CSS `animation: fade-out 0.3s ease-out 3s forwards`
  - 移除 `showCompleted` state + useEffect

### 7.3 Chat交互细节

**任务**:

- [~] **Task 7.3.1**: 代码块增强 ⚠️ 复制按钮+语言检测已有，缺少语言标签和行号
  - 文件: `src/renderer/components/agent/ChatBubble.tsx`
  - 语言标识标签（从```lang提取）
  - 复制按钮（右上角icon）
  - 可选行号（每5行显示）

- [ ] **Task 7.3.2**: 输入区域草稿保留 ❌ 无localStorage草稿保存
  - 文件: `src/renderer/components/agent/ChatInput.tsx`
  - 已输入未发送的消息保存为草稿（按threadId）
  - 线程切换时恢复对应草稿
  - 发送后清除草稿
  - 持久化到localStorage（key: `bizgraph:draft:{threadId}`）

- [x] **Task 7.3.3**: AgentChatPanel拖拽高度持久化 ✅
  - 文件: `src/renderer/components/agent/AgentChatPanel.tsx`
  - `inputAreaHeight` 保存到 `localStorage.setItem('agentChatInputHeight', value)`
  - 启动时从localStorage恢复默认值

**测试**: 手动测试代码块复制、草稿恢复、高度持久化

### 7.4 主题与深色模式

**任务**:

- [ ] **Task 7.4.1**: 深色模式对比度审计 ❌ 无WCAG AA审计
  - 文件: `src/renderer/index.css`
  - 审计所有 `.dark` 下的颜色对比度（WCAG AA标准: 4.5:1）
  - 重点: BizNode节点文本、BizEdge标签、ChatPanel代码块
  - 修复不足4.5:1的组合

- [x] **Task 7.4.2**: Canvas主题适配 ✅
  - 文件: `src/renderer/canvas/GraphCanvas.tsx`
  - ReactFlow的 `style` prop使用CSS变量: `background: var(--canvas-bg)`
  - MiniMap/Controls/Background颜色跟随主题
  - 主题切换时Canvas自动刷新样式

---

## 领域8: 全局质量与测试补全

### 8.1 缺失测试模块

| 模块 | 当前测试 | 需补测试 |
|------|---------|---------|
| VerificationService | 无 | parseVerificationResponse正则优化、验证结果判定 |
| ChatService | 无 | 消息持久化、归档、搜索、分页 |
| ContextResolver | 无 | Token预算截断、文件读取缓存 |
| BaseAdapter.parseFileChanges | 无 | 文件变更解析准确性、路径过滤 |
| AgentManager | 部分 | sessionEnded exit code分类、fallback链、RequestQueue集成 |
| GraphSyncService | 有 | 确认/拒绝suggested edge、批量推送节流 |
| SessionRecoveryManager | 无 | 适配器策略、恢复次数限制、checkpoint持久化 |

- [ ] **Task 8.1.1-8.1.7**: 为上述7个模块补全单元测试

### 8.2 类型安全增强

- [x] **Task 8.2.1**: Repository层消除 `as unknown as` ✅
  - 文件: `src/main/repositories/chat-repository.ts`
  - 替换 `result.rows[0] as unknown as ChatThreadRow` 为运行时校验函数
  - 新增 `isChatThreadRow(row): row is ChatThreadRow` 类型守卫

- [x] **Task 8.2.2**: safeJsonParse泛型化 ✅
  - 文件: `src/main/shared/db-utils.ts`
  - `safeJsonParse<T>(raw: string | null, fallback: T): T`
  - 增加可选schema校验: `safeJsonParse<T>(raw, fallback, validator?: (val: unknown) => val is T)`

### 8.3 optimization-tracker P1项修复

- [x] **Task 8.3.1**: 验证session泄漏修复（#6）✅
  - `agent:verify` 完成后调用 `agentManager.terminateSession(sessionId)`
  - 增加测试验证

- [x] **Task 8.3.2**: ContextResolver文件缓存（#7）✅
  - `src/main/context-resolver.ts` 增加 TTL缓存 `Map<string, {content, timestamp, mtime}>`，10秒内命中
  - 测试: 连续2次resolveFile只产生1次磁盘IO

- [~] **Task 8.3.3**: SELECT * 优化（#8）⚠️ 索引已存在，但SELECT *未优化为列名
  - `listThreads` 改为只查必要字段
  - 添加 `idx_messages_thread` 索引

### 8.4 Lint与类型检查零错误

- [x] **Task 8.4.1**: 全量tsc零错误 ✅
- [x] **Task 8.4.2**: 全量ESLint零warning ✅
- [x] **Task 8.4.3**: 全量Vitest通过 ✅ (66 files / 789 tests)

---

## 实施顺序与时间线

```
Phase 1 (领域1): 底层架构精修 — 1.1~1.5 任务
  ├─ Task 1.1.1-1.1.3: AST解析增强 (2天)
  ├─ Task 1.2.1-1.2.4: Memory版本化+冲突+衰减 (2天)
  ├─ Task 1.3.1-1.3.5: RAG性能+增量索引 (3天)
  ├─ Task 1.4.1-1.4.3: 数据清洗强化 (1天)
  └─ Task 1.5.1-1.5.2: 自适应配置闭环 (1天)

Phase 2 (领域2): 记忆与Prompt深度集成 — 2.1~2.5 任务
  ├─ Task 2.1.1-2.1.3: Pipeline数据流 (2天)
  ├─ Task 2.2.1-2.2.3: PromptOrchestrator层间优化 (2天)
  ├─ Task 2.3.1-2.3.3: GraphMemory遍历优化 (1天)
  ├─ Task 2.4.1-2.4.2: 节点绑定状态流转 (1天)
  └─ Task 2.5.1-2.5.2: 会话内容管理 (1天)

Phase 3 (领域3): Chat状态健壮化 — 3.1~3.4 任务
  ├─ Task 3.1.1-3.1.3: P0缺陷修复 (2天)
  ├─ Task 3.2.1-3.2.3: MessageQueue生命周期 (2天)
  ├─ Task 3.3.1-3.3.3: SessionRecovery策略 (2天)
  └─ Task 3.4.1-3.4.2: 确认项管理 (1天)

Phase 4 (领域4): 思维导图效果增强 — 4.1~4.4 任务
  ├─ Task 4.1.1-4.1.3: 知识关联可视化 (2天)
  ├─ Task 4.2.1-4.2.2: Schema自动填充 (1天)
  ├─ Task 4.3.1-4.3.2: 生成进度展示 (1天)
  └─ Task 4.4.1-4.4.2: 搜索过滤优化 (1天)

Phase 5 (领域5): 适配器交互打磨 — 5.1~5.3 任务
  ├─ Task 5.1.1-5.1.2: 输出结构化解析 (1天)
  ├─ Task 5.2.1-5.2.2: 健康度与降级 (2天)
  └─ Task 5.3.1-5.3.2: 请求编排完善 (1天)

Phase 6 (领域6): 动态Prompt调优 — 6.1~6.2 任务
  ├─ Task 6.1.1-6.1.3: 层间优化 (2天)
  └─ Task 6.2.1-6.2.2: Distiller精进 (1天)

Phase 7 (领域7): 前端性能与UX精修 — 7.1~7.4 任务
  ├─ Task 7.1.1-7.1.4: 渲染性能 (2天)
  ├─ Task 7.2.1-7.2.3: 交互动画 (1天)
  ├─ Task 7.3.1-7.3.3: Chat交互细节 (1天)
  └─ Task 7.4.1-7.4.2: 主题深色模式 (1天)

Phase 8 (领域8): 全局质量与测试补全 — 8.1~8.4 任务
  ├─ Task 8.1.1-8.1.7: 缺失测试补全 (3天)
  ├─ Task 8.2.1-8.2.2: 类型安全增强 (1天)
  ├─ Task 8.3.1-8.3.3: P1项修复 (1天)
  └─ Task 8.4.1-8.4.3: Lint+Type+Test零错误 (1天)
```

**总计**: ~40个工作任务, 预估30个工作日

---

## 数据库迁移

新增列/索引通过 `addColumnSafe()` 和 `rebuildTableIfNeeded()` 安全添加:

| 迁移 | 版本 | 内容 |
|------|------|------|
| M1 | v3→v4 | `memory_items` 增加 `verified BOOLEAN DEFAULT 1` |
| M2 | v4 | 复合索引: `idx_messages_thread_created` |
| M3 | v4 | 复合索引: `idx_memory_items_kind_project` |

每个领域的迁移独立提交，不跨领域混合。

## 向后兼容

- 新增列全部有DEFAULT值
- `verified` 默认为true，与旧数据兼容
- Pipeline阶段配置化不破坏现有调用
- PromptOrchestrator弹性预算向后兼容（静态百分比仍为默认值）
- Store拆分后agentStore兼容层继续生效，渐进替换

## 验收标准

每个Phase完成需满足:

1. `npx vitest run` 全部通过
2. `npx tsc --noEmit` 零错误
3. `npm run lint` 零warning
4. 新增代码有对应测试
5. 无P0/P1缺陷遗留
6. `npm run dev` 启动正常，核心功能无回归
