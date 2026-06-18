# BizGraph 全面打磨设计文档

> 日期: 2026-06-17
> 状态: 待实施
> 策略: 纵向深度，从底层到前端逐领域推进
> 方法: 混合方案 — C(重写最薄弱环节)、B(重构深层问题)、A(渐进增强已适配部分)

---

## 优先级排序

1. Agent底层架构 (决定上限)
2. 记忆与动态Prompt系统 (提升效果)
3. Chat会话状态管理 (使用体验)
4. 思维导图与知识图谱 (真实效果)
5. Agent适配器系统 (正常使用和交互)
6. 前端界面与用户体验 (最终体现)

## 闲置模块评估结果

| 模块 | 判定 | 关键原因 |
|------|------|---------|
| HallucinationChecker | 直接接入 | 核心逻辑健全，补全死代码和缺失 critical 级别即可 |
| ObserverCompressor | 直接接入 | 最完善模块，状态机设计好，OOM保护+Jaccard去重 |
| ContextCompiler | 重构后接入 | 核心概念对但有bug(getMemoryStore不一致)、缺L4层、零测试 |
| WaterlineSync | 重构后接入 | 数据模型好但持久化未实现、匹配逻辑松散导致误判 |

---

## Section 1: Agent底层架构优化

### 1.1 AST解析优化 (方案A - 渐进增强)

**现状**: `ast-parser.ts` 支持 JS/TS/Python/Go/Rust/Java，基于 regex + tree-sitter-wasm，错误恢复不足，解析失败时直接返回空结果。

**改进**:
- **渐进式降级**: tree-sitter解析失败 → regex fallback → 最小结构提取（仅文件级声明）
- **增量解析**: 缓存AST，仅重新解析变更文件，通过 `file-watcher.ts` 变更事件触发
- **语言扩展**: Vue SFC 解析、SQL 解析
- **位置信息补全**: entity-extractor 补全行列号，支持精确定位

### 1.2 Memory持久化优化 (方案C - 重写)

**现状**: MemoryStore 有 FTS5 检索但无版本控制、无冲突解决；WaterlineSync 纯内存无持久化。

**重写内容**:
- **版本化记忆条目**: 每条 MemoryItem 增加 `version` + `parent_version`，支持演进链追踪
- **时间戳+置信度合并** (非完整CRDT): 多会话同时修改同一概念的记忆时，按时间戳取最新、置信度取最高合并，冲突时保留两者供后续检索选择
- **WaterlineSync 持久化**: 将 waterline 状态写入 memory_items 表（kind='waterline'），启动时从DB恢复
- **记忆衰减曲线**: 基于时间的衰减（非简单90天阈值），高置信度衰减慢，低置信度衰减快
- **容量管理**: 每项目记忆条目上限 + 淘汰策略（置信度×新鲜度权重排序）

### 1.3 RAG结构优化 (方案C - 重写)

**现状**: HybridSearchEngine 用 BM25 关键词向量，不是真正的语义检索。无 embedding 模型。

**重写内容**:
- **本地 embedding 生成**: 使用 `@xenova/transformers` (ONNX Runtime Web) 在本地运行 embedding 模型 `Xenova/all-MiniLM-L6-v2`（384维，模型约30MB，首次使用时从HuggingFace下载并缓存到用户数据目录）
- **向量存储**: 在 LibSQL 中用 JSON 列存储 embedding 向量，查询时计算余弦相似度
- **文档切分重构**: 从固定长度切分升级为语义切分——按 AST 节点边界、函数边界、段落边界切分
- **混合检索**: FTS5 关键词 + embedding 向量双路检索，加权融合排序
- **增量索引**: 文件变更时只更新相关文档片段的 embedding，不全量重建

### 1.4 数据清洗流程 (方案A - 渐进增强)

**现状**: ObserverCompressor 有基本的噪声过滤，但缺少标准化和质量检查。

**改进**:
- **输入标准化管道**: 统一不同适配器输出格式差异，建立 `OutputNormalizer`
- **噪声过滤增强**: ObserverCompressor feed 入口增加进度条/时间戳/重复行等噪声模式过滤
- **质量检查关卡**: 接入 HallucinationChecker（直接接入），记忆提取后自动验证
- **Poisoned 输入识别**: MemoryExtractor 增加 poisoned 输出自动丢弃而非存储

### 1.5 自动优化机制 (方案B - 重构)

**现状**: 无自适应参数调整，所有阈值都是硬编码常量。

**重构: AdaptiveConfig 框架**:
- **运行时可调配置**: 基于使用模式自动调参
  - 压缩阈值: 根据输出大小分布自适应（当前固定800 token）
  - 检索权重: FTS vs 向量权重根据查询结果质量动态调整
  - 记忆容量: 根据项目规模和活跃度调整上限
- **使用模式追踪**: 记录每次操作耗时和结果质量，作为调参依据
- **反馈闭环**: 用户确认/拒绝的记忆条目作为质量信号反馈到提取策略

---

## Section 2: 记忆与动态Prompt系统优化

### 2.1 记忆系统架构重构 (方案B)

**重构: ContextPipeline 统一管线**

```
Agent输出 → OutputNormalizer → ObserverCompressor.feed()
                                         ↓ (flush/finalize)
                                    MemoryExtractor.extract()
                                         ↓
                                    HallucinationChecker.verify()  ← 直接接入
                                         ↓ (passed/flagged)
                                    ContextCompiler.compile()      ← 重构后接入
                                         ↓
                                    WaterlineSync.advance()        ← 重构后接入
                                         ↓
                                    MemoryStore.persist()
```

每个阶段是独立的 `PipelineStage` 接口，可替换、可跳过、可测试:
- `OutputNormalizerStage` — 标准化不同适配器输出
- `CompressionStage` — ObserverCompressor 封装
- `ExtractionStage` — MemoryExtractor 封装
- `VerificationStage` — HallucinationChecker 封装
- `CompilationStage` — ContextCompiler 封装（重构：补L4层、修bug、补测试）
- `WaterlineStage` — WaterlineSync 封装（重构：加持久化、修匹配逻辑）
- `PersistenceStage` — MemoryStore 持久化

管线由 `PipelineRunner` 编排，支持：阶段跳过、错误隔离（某阶段失败不阻塞后续）、钩子回调。

### 2.2 动态Prompt生成 (方案B)

**重构: PromptOrchestrator**

统一 prompt 组装入口:
1. **系统指令层** — 适配器类型、角色定义、输出格式约束（固定预算，不可压缩）
2. **业务约束层** — ScopePromptBuilder 生成（高优先级，可适度压缩）
3. **上下文知识层** — ContextCompiler.renderWithHistory() 生成（弹性预算，动态调整L1-L4深度）
4. **水位线层** — WaterlineSync.formatContext() 生成（低token开销，总是包含）
5. **用户指令层** — 当前对话的具体请求（不可压缩）

每层有独立的 token 预算分配，按优先级从高到低填充。

### 2.3 图谱知识上下文 (方案A)

- GraphMemory BFS 遍历结果作为 ContextCompiler L3 层补充
- 节点关联代码片段（SmartContextResolver）注入 L2 层
- 历史变更摘要（git-agent）注入 L4 层

### 2.4 思维导图节点绑定 (方案A)

- Agent 会话结束时，WaterlineSync.markNodeVerified 自动触发节点状态更新
- 文件变更解析后自动关联到功能节点，更新 `metadata.lastModified`
- 补全 placeholder → developing 状态流转：Agent 开始在关联文件上工作时自动触发

### 2.5 会话内容管理 (方案A)

- **消息分页**: `listMessages` 增加 `limit` + `offset`，默认加载最近50条
- **上下文窗口管理**: ContextCompiler.renderWithHistory 只加载最近N条消息
- **会话归档**: 超30天不活跃线程自动归档(status=archived)
- **存储清理**: 提供 IPC 接口清理超过90天的归档线程

### 2.6 上下文提纯算法 (方案B)

**重构: ContextDistiller**

在 PromptOrchestrator 组装过程中插入提纯阶段:
- **跨轮次冗余消除**: 比较当前与历史上下文 embedding 相似度，高度重复段落只保留最新版本
- **信息密度排序**: 计算每个片段信息密度（唯一实体数/总token数），低密度片段降级或丢弃
- **关键实体保留**: 保留首次出现的概念定义、错误信息、决策记录
- **token 预算约束**: 超限时从低优先级片段开始裁剪

### 2.7 业务逻辑转图谱 (方案A)

- 利用重构后的 RAG 提供相似项目图谱结构作为 few-shot 示例
- SchemaValidator 校验失败反馈回传 LLM 重试
- 增加结构化输出约束：要求 LLM 输出符合预定义 JSON Schema

### 2.8 LLM自动触发 (方案A)

- file-watcher 变更与节点关联文件匹配，匹配则触发增量分析
- 变更分级：小变更不触发，中等变更触发状态更新，大变更触发结构调整建议
- 触发结果通过 EventBus 通知 renderer，需用户确认

---

## Section 3: Chat会话状态管理优化

### 3.1 状态管理架构重构 (方案B)

**拆分 agentStore (573行) 为4个专注 store**:

1. **adapterStore (~150行)** — 适配器列表、偏好设置、市场数据、健康状态
   - adapters[], adapterPreferences, marketplaceItems
   - checkInstalled(), setPreference(), refreshMarketplace()

2. **threadStore (~200行)** — 线程CRUD、消息管理、分页
   - threads[], currentThreadId, messagePages (Map<threadId, MessagePage>)
   - createThread(), loadThread(), archiveThread(), loadMoreMessages()

3. **sessionStore (~120行)** — 会话生命周期、Agent绑定、状态追踪
   - activeSessions (Map<threadId, SessionState>), sessionStatuses
   - createSession(), resumeSession(), terminateSession(), bindSession()

4. **messageStore (~150行)** — 消息发送、流式处理、重试、确认
   - streamingStates, sendQueue, pendingConfirmations
   - sendMessage(), appendStreaming(), retry(), confirmAction()

**跨 store 通信**: 通过 EventBus 扩展，新增事件:
- `SESSION_STARTED` / `SESSION_TERMINATED`
- `STREAMING_CHUNK`
- `MESSAGE_SENT` / `MESSAGE_FAILED`
- `ADAPTER_HEALTH_CHANGE`

### 3.2 提问流程管理 (方案C - 重写)

**重写: MessageQueue 带并发控制**:
- 并发控制: 每适配器同时最多1个活跃请求，排队等待
- 优先级: 用户消息 > 重试消息 > 系统消息
- 去重: 相同 threadId + 精确字符串匹配 content 5秒内不重复发送
- 上下文注入: 发送前通过 PromptOrchestrator 组装上下文
- 取消支持: 排队消息可取消，执行中消息通过 AbortController 中断

消息生命周期: `queued → preparing → sending → streaming → completed/failed`

### 3.3 错误中断重连 (方案C - 重写)

**重写: SessionRecoveryManager**:
- 进程异常检测: 监听 child_process exit(code≠0) / signal / timeout
- 自动重连策略:
  - Claude Code: 自动 --resume 恢复
  - MCP Adapter: 创建新会话，注入最近上下文
  - 其他CLI: 新建会话，通知用户确认
- 消息恢复: 重连后自动加载最近3条消息作为上下文
- 状态恢复: thread status 从 error 恢复为 running
- 最大重试: 3次，超过后标记 error 并提示用户

### 3.4 确认项管理 (方案A)

- 在 ScopeGuard 基础上增加确认关卡
- 高风险操作自动拦截: 删除文件、修改配置、变更超过5个文件
- 拦截后发送 `CONFIRMATION_REQUIRED` 事件到 renderer
- 用户确认后解锁继续，拒绝则回滚变更
- 低风险操作（格式化、注释修改）跳过确认

### 3.5 临时中断恢复 (方案A)

- **会话快照**: Agent 返回结果后自动保存快照（最近输出+上下文状态+文件变更列表）
- **中断恢复**: 重新打开已中断线程时显示"继续上次会话"提示
- **草稿保留**: 已输入未发送的消息保存为草稿，线程切换时保留
- **状态持久化**: sessionStore activeSessions 写入 localStorage

---

## Section 4: 思维导图画布与知识图谱优化

### 4.1 图谱知识关联 (方案A)

- **多维度关联**: 增加代码依赖(AST import)、语义相似(embedding)、变更耦合(git co-change)
- **关联置信度评分**: 各方法独立评分（代码依赖0.9、语义相似0.7、变更耦合0.6、文件名重叠0.4、时间接近0.3），加权平均后 >0.6 才写入图谱
- **反向验证**: 检查已有关联是否矛盾，保留高置信度一方
- **关联可视化**: 不同线型颜色区分类型（语义=虚线蓝、依赖=实线绿、变更耦合=点线橙）

### 4.2 图谱知识细化 (方案A)

- **节点内容 schema**: 每种节点类型定义元数据 schema
  - module: `{ frameworks, entryPoints, keyFiles, techStack }`
  - process: `{ apiEndpoints, dataFlow, stakeholders, frequency }`
  - feature: `{ acceptanceCriteria, linkedFiles, testCoverage, priority }`
  - bug: `{ severity, reproduction, affectedUsers, fixDeadline }`
- **schema 验证**: 写入时通过 SchemaValidator 校验
- **智能填充**: ProjectScanner 扫描结果自动填充 schema 字段

### 4.3 导图与图谱双向同步 (方案B)

**重构: GraphSyncService**:
- Canvas → GraphMemory: 节点创建/删除/移动/内容变更 → 更新图谱
- GraphMemory → Canvas: 新关联发现 → 创建建议边（虚线，需确认）；置信度变化 → 更新视觉样式
- 同步策略: Canvas操作实时写入；关联发现每30秒批量推送；用户操作优先于自动推断

### 4.4 导图索引优化 (方案A)

- **前端搜索索引**: graphStore 维护 nodeIndex Map（name→nodeId, type→nodeId[]），增量更新
- **数据库索引补充**:
  - `nodes(graph_id, type)` — 按图+类型过滤
  - `nodes(graph_id, status)` — 按图+状态过滤
  - `chat_threads(adapter_name, status)` — 按适配器+状态过滤
  - `chat_messages(thread_id, status)` — 按线程+状态过滤
  - `memory_items(project_id, created_at DESC)` — 按项目+时间排序
- **过滤排序优化**: tree view 支持按状态/类型/最近修改快速过滤

### 4.5 图谱查询速度 (方案A)

- **查询结果缓存**: QueryCache LRU 缓存（最多100条），key=(起点nodeId+深度+关系类型)
- **增量更新**: 变更时只失效相关缓存条目
- **预计算**: 启动时对高频查询模式预计算
- **批量查询接口**: 支持一次查询多个节点关联

### 4.6 导图生成展示 (方案A)

- **生成进度追踪**: MindmapAgent 每阶段通过 EventBus 发送进度事件
- **进度UI**: Canvas 上叠加进度条+当前阶段描述
- **预览功能**: 生成完成先显示半透明预览节点，用户确认后写入
- **分阶段生成**: 大项目先生成模块层，确认后继续生成 process/feature 层
- **回退能力**: 预览节点可一键清除

---

## Section 5: Agent适配器系统优化

### 5.1 适配器连接速率优化 (方案A)

- **并行检测**: 所有 checkInstalled() 并行执行（Promise.allSettled）
- **结果缓存**: 检测结果缓存5分钟，使用时再验证一次
- **延迟加载**: 适配器描述信息按需加载
- **Registry 预过滤**: 根据操作系统和已有工具预过滤适配器列表

### 5.2 错误捕捉与处理 (方案A)

- **BaseAdapter 统一错误边界**: doSendCommand() 包裹 try-catch，未预期异常转为 AdapterError
- **进程崩溃恢复**: 按exit code分类处理
  - 137/143: 正常终止，不重试
  - 1(一般错误): 自动重试1次（重试前通过 ScopeGuard 检查文件状态，如有部分修改则先回滚）
  - 126/127: 标记不可用，提示安装
  - 其他: 记录日志，通知用户
- **Circuit Breaker 推广**: McpAdapter 的 circuit breaker 提取到 BaseAdapter
- **超时分层**: 连接超时(10s)、首字节超时(30s)、总执行超时(5min)

### 5.3 Chat交互效果优化 (方案A)

- **输出结构化解析**: JsonProtocolHandler 增加输出模式识别（文件操作/错误/进度）
- **实时进度条**: AgentChatPanel 根据结构化进度事件渲染
- **输出折叠**: 长输出(>20行)自动折叠为摘要
- **中断后状态恢复**: 中止时已解析的文件变更保留在 DiffReviewPanel

### 5.4 适配器交互统一API (方案A)

- **AdapterCapability 枚举**: 统一定义能力（tools, resume, streaming, multiTurn, scopeGuard）
- **每个适配器声明 capabilities**: 替代分散的布尔属性
- **AdapterManager 按能力路由**: 请求自动选择具备能力的适配器
- **降级链声明**: 每个适配器声明 fallback（如 claude-code → mcp:anthropic）

### 5.5 适配器请求编排 (方案A)

- **请求队列**: AgentManager 维护全局请求队列，每适配器并发上限可配置
- **去重逻辑**: 相同 nodeContext + command 30秒内合并
- **优先级调度**: 用户主动触发 > 自动触发
- **资源感知**: 检测系统负载，高负载时降低并发

### 5.6 降级回调机制 (方案A)

- **降级链配置**: 每个适配器声明 fallback 链
- **能力感知降级**: 降级时明确告知丢失的能力
- **用户通知**: 降级时 ChatPanel 显示降级提示条
- **自动恢复检测**: 降级后每分钟检测首选适配器是否恢复
- **手动覆盖**: 用户可在降级状态下手动选择适配器

---

## Section 6: 前端界面与用户体验优化

### 6.1 页面渲染性能优化 (方案A)

- **graphStore 粒度优化**: 内部用 Map<id, Node> 存储以支持单节点更新，对外通过 `useStore` selector 暴露 ReactFlow 需要的数组视图，selector 内做浅比较避免不必要重渲染
- **组件 memo 强化**: BizNode 比较函数增加 agentStatus/bugCount/status 显式比较
- **虚拟列表**: TreeView/ThreadListOverlay 超100条时启用虚拟滚动
- **大量节点降级**: 500+ 节点时隐藏 MiniMap 动画、简化边渲染

### 6.2 界面交互动画流畅度 (方案A)

- **节点选中过渡**: 150ms CSS transition（边框、阴影、缩放）
- **上下文菜单动画**: Popover fade + scale 动画（100ms）
- **拖拽性能**: 拖拽时临时禁用非选中节点 re-render
- **缩放优化**: 缩放中隐藏节点文本，停止500ms后恢复
- **连接线反馈**: 拖拽创建连接时目标节点高亮呼吸动画

### 6.3 Chat交互体验 (方案A)

- **流式显示去重**: 每个 chunk 添加序列号，丢弃乱序或重复
- **加载骨架屏**: Agent 思考/执行中显示打字机效果骨架动画
- **错误提示友好化**: 按类型映射用户友好文本
  - 超时 → "Agent 响应超时，请重试或检查网络连接"
  - 权限不足 → "当前适配器权限不足，请检查安装或切换适配器"
  - 进程崩溃 → "Agent 进程异常退出，已自动保存进度"
- **消息状态指示**: 每条消息显示发送/流式/完成/失败状态图标
- **代码块增强**: 语言标识、复制按钮、行号

### 6.4 整体样式与主题 (方案A)

- **CSS 变量统一**: 所有颜色迁移到 hsl(var(--xxx))，消除硬编码
- **主题 token 补全**: 补充缺失 semantic token（--agent-running, --bug-critical, --node-placeholder）
- **深色模式完善**: 审计所有组件深色模式可读性和对比度
- **主题切换过渡**: 200ms 全局 transition
- **Canvas 主题适配**: 节点/边/MiniMap/Controls 跟随主题

### 6.5 加载速度优化 (方案A)

- **路由级懒加载**: ChatPanel/SettingsPanel/DiffReviewPanel 改为 React.lazy + Suspense
- **预加载策略**: hover Chat tab 时预加载 ChatPanel 代码
- **Bundle 分析**: 添加 rollup-plugin-visualizer
- **Electron 启动优化**: 非关键服务延迟初始化

### 6.6 页面布局响应式 (方案A)

- **弹性宽度**: Canvas 占据剩余空间，左右面板固定最小宽度+拖拽调整
- **折叠面板**: 左右面板支持折叠为图标栏，Canvas 全屏模式
- **小屏适配**: 窗口 <1024px 自动切换 Tab 式布局
- **Chat 面板定位**: 大屏侧边固定，小屏底部抽屉式弹出
- **面板状态持久化**: 宽度、折叠状态写入 localStorage

---

## 数据库迁移策略

新增列和表需通过 `addColumnSafe()` 和 `rebuildTableIfNeeded()` 在 `migrate()` 中安全添加：

- `memory_items`: 增加 `version INTEGER DEFAULT 1`, `parent_version INTEGER DEFAULT NULL`, `embedding TEXT DEFAULT NULL`（JSON数组）
- `nodes`: 增加 `metadata_schema TEXT DEFAULT NULL`（JSON schema约束）
- `nodes` 新复合索引: `idx_nodes_graph_id_type`, `idx_nodes_graph_id_status`
- `chat_threads` 新复合索引: `idx_chat_threads_adapter_status`
- `chat_messages` 新复合索引: `idx_chat_messages_thread_status`
- `memory_items` 新复合索引: `idx_memory_items_project_created`

迁移版本递增 CURRENT_SCHEMA_VERSION，每个领域的迁移独立提交，不跨领域混合。

## 向后兼容

- 新增列全部有 DEFAULT 值，旧数据自动填充
- embedding 列初始为 NULL，旧记忆条目在首次检索时异步生成 embedding
- MemoryItem.version 默认为1，与旧数据兼容
- adapterStore/threadStore/sessionStore/messageStore 拆分后，旧代码通过中间层过渡，不一次性替换所有引用
- ContextPipeline 的 PipelineRunner 支持跳过未实现的阶段，确保部分完成时系统仍可运行

---

## 领域间依赖关系

```
底层架构(1) ──→ 记忆/Prompt(2) ──→ Chat状态(3) ──→ 思维导图(4) ──→ 适配器(5) ──→ 前端(6)
    │                │                 │                │               │            │
    │                │                 │                │               │            │
    └─ RAG重写 ──────┘                 │                │               │            │
    └─ Memory重写 ────┘                │                │               │            │
    └─ AdaptiveConfig ────────────────┘                │               │            │
                       └─ ContextPipeline ─────────────┘               │            │
                       └─ PromptOrchestrator ──────────────────────────┘            │
                                        └─ MessageQueue ────────────────────────────┘
                                        └─ SessionRecovery ─────────────────────────┘
                                                       └─ GraphSyncService ──────────┘
                                                       └─ QueryCache ────────────────┘
                                                                      └─ AdapterCapability ─┘
                                                                      └─ 降级链 ────────────┘
                                                                                     └─ CSS变量 ─┘
```

关键依赖:
- Section 2 (记忆/Prompt) 依赖 Section 1 的 RAG 重写和 Memory 重写
- Section 3 (Chat状态) 依赖 Section 2 的 PromptOrchestrator
- Section 4 (思维导图) 依赖 Section 1 的 embedding 和 Section 2 的 ContextPipeline
- Section 5 (适配器) 对 Section 3/4 有轻依赖（EventBus 事件）
- Section 6 (前端) 依赖前面所有层的接口稳定

## 实施顺序

按领域纵向深度推进，每个领域完成后再开始下一个:

1. **Agent底层架构** — AST增强、Memory重写、RAG重写、数据清洗、AdaptiveConfig
2. **记忆与Prompt** — ContextPipeline、PromptOrchestrator、ContextDistiller、节点绑定、LLM触发
3. **Chat会话状态** — Store拆分、MessageQueue重写、SessionRecovery重写、确认项、中断恢复
4. **思维导图/知识图谱** — 知识关联、细化、GraphSyncService、索引优化、查询缓存、生成展示
5. **Agent适配器** — 连接速率、错误处理、Chat效果、统一API、请求编排、降级回调
6. **前端界面** — 渲染性能、动画、Chat体验、主题、加载速度、响应式
