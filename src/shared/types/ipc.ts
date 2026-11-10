/**
 * IPC 通信类型定义
 * 包含 IpcApi 接口和所有 IPC 通信相关类型
 */

import type {
  Graph, GraphType, GraphNode, GraphEdge, BugNode, GraphSnapshot, GraphFetchOptions,
  NodeStatus, ContextRef, NodeTypeConfig, ReparentResult,
  ProjectScanResult, ScanModule, NodeEnrichment, NodeType,
} from './graph'
import type {
  AgentSessionConfig, AgentCommand, AgentOutput, AgentLog, AgentThread,
  ChatMessage, FileSearchResult, CliToolConfig, BizGraphSettings,
  VerificationReport, CodeIntelExecutionPlan, SymbolQueryResult,
  SymbolKind, ValidationResult, AdapterFallbackAttempt, AdapterPreferences,
  AgentMode, AgentModeConfig, AdapterMarketplaceItem, MemoryItem, MemoryKind,
  CompactHistoryEntry, ContextState, CompactResult, CompactStrategy,   // Phase 2/3 additions
  AdapterHealthScore,                                                    // D4 健康度面板
} from './agent'
import type {
  AgentTypeDefinition,
  SubagentInvocation,
  SubagentPartialSummary,
  SubagentResult,
} from './subagent'
import type {
  ApprovalDecisionInput,
  ApprovalRequestPayload,
  ApprovalResolutionPayload,
  AgentRuntimeFlags,
  DriverCapabilities,
  NormalizedEventEnvelope,
  SessionGrantInfo,
  SessionRecoveryInfo,
  SessionUsageView,
  GraphUsageView,
  AgentStorageStats,
} from './agent-runtime'
import type { ParsedWikiContent, DanglingLink, IngestResult, IngestMode, LintReport, LintFixResult, LintFixAction, ComputeResult, WritebackItem, RollbackResult } from './wiki'
import type {
  RecipeDefinition,
  RecipeRun,
  RecipeRunProgressEvent,
  RecipeRunRequest,
  RecipeDag,
} from './recipe'
import type { UserIdentity } from './agent'
import type { ConflictReport } from './conflict'
import type {
  A2ARemoteAgent,
  A2AServerConfig,
  A2AAgentCard,
  A2AServerStatus,
} from './a2a'

/** D10b: Awareness server 连接信息（inline 避免跨目录引用） */
export interface RealtimeConnectionInfo {
  /** WebSocket URL（含协议/host/port） */
  wsUrl: string
  /** 当前服务监听的端口 */
  port: number
  /** 是否已启动 */
  started: boolean
}
// ============================================
// IPC 通信类型
// ============================================

export interface IpcApi {
  // 图操作
  'graph:create': (data: { name: string; type: GraphType }) => Promise<Graph>
  'graph:list': () => Promise<Graph[]>
  'graph:get': (id: string, options?: GraphFetchOptions) => Promise<{ graph: Graph; nodes: GraphNode[]; edges: GraphEdge[]; bugs: BugNode[] } | null>
  'graph:delete': (id: string) => Promise<boolean>
  'graph:derive': (sourceGraphId: string, name?: string) => Promise<Graph>
  /** 换父 —— 父子关系变更的唯一入口（主进程 HierarchyService 负责校验与事务） */
  'graph:reparent': (nodeId: string, newParentId: string) => Promise<ReparentResult>

  // 节点操作
  'node:create': (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GraphNode>
  'node:createBatch': (nodesData: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>[]) => Promise<GraphNode[]>
  'node:update': (id: string, data: Partial<GraphNode>) => Promise<GraphNode & { warnings?: string[] }>
  'node:delete': (id: string) => Promise<boolean>
  'node:batchUpdatePositions': (updates: Array<{ id: string; x: number; y: number }>) => Promise<boolean>

  // 节点类型规则 —— 单一权威在主进程 nodeTypeRegistry，渲染端只读
  'nodeType:listConfigs': () => Promise<NodeTypeConfig[]>

  // 边操作
  'edge:create': (data: Omit<GraphEdge, 'id'>) => Promise<GraphEdge>
  'edge:update': (id: string, data: Partial<GraphEdge>) => Promise<GraphEdge>
  'edge:delete': (id: string) => Promise<boolean>

  // Bug 操作
  'bug:create': (data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<BugNode>
  'bug:update': (id: string, data: Partial<BugNode>) => Promise<BugNode>
  'bug:delete': (id: string) => Promise<boolean>
  'bug:listByNode': (nodeId: string) => Promise<BugNode[]>

  // 快照操作
  'snapshot:create': (graphId: string, name: string) => Promise<GraphSnapshot>
  'snapshot:list': (graphId: string) => Promise<Omit<GraphSnapshot, 'data'>[]>
  'snapshot:load': (id: string) => Promise<GraphSnapshot | null>
  'snapshot:delete': (id: string) => Promise<boolean>

  // Wiki 操作
  'wiki:resolveLink': (graphId: string, targetTitle: string) => Promise<string | null>
  'wiki:parseContent': (graphId: string, content: string) => Promise<ParsedWikiContent>
  'wiki:getBacklinks': (nodeId: string) => Promise<{ id: string; title: string }[]>
  'wiki:findDangling': (graphId: string) => Promise<DanglingLink[]>
  'wiki:ingestFiles': (graphId: string, filePaths: string[], mode?: IngestMode) => Promise<IngestResult>
  'wiki:computeCommunities': (graphId: string) => Promise<ComputeResult>
  'wiki:lint': (graphId: string) => Promise<LintReport>
  'wiki:applyFix': (graphId: string, fix: LintFixAction) => Promise<LintFixResult>
  'wiki:listWriteback': (graphId: string) => Promise<WritebackItem[]>
  'wiki:countWriteback': (graphId: string) => Promise<number>
  'wiki:acceptWriteback': (itemId: string) => Promise<void>
  'wiki:discardWriteback': (itemId: string) => Promise<void>
  'wiki:rollbackWriteback': (itemId: string) => Promise<RollbackResult>
  'wiki:listWritebackHistory': (graphId: string, sinceIso?: string) => Promise<WritebackItem[]>

  // Agent 操作
  'agent:checkInstalled': (adapterName: string) => Promise<boolean>
  'agent:startSession': (adapterName: string | null, config: AgentSessionConfig) => Promise<{ sessionId: string; fallback?: boolean; adapterUsed?: string; fallbackHistory?: AdapterFallbackAttempt[] }>
  'agent:sendCommand': (sessionId: string, command: AgentCommand) => Promise<void>
  'agent:resolveAndSendCommand': (sessionId: string, command: AgentCommand, contextRefs: ContextRef[], nodeIds: string[]) => Promise<void>
  'agent:terminateSession': (sessionId: string) => Promise<void>
  'agent:listAdapters': () => Promise<{ name: string; version: string; installed: boolean }[]>
  'agent:getAdapterMarketplace': () => Promise<AdapterMarketplaceItem[]>
  // D4: 健康度面板 — 返回所有已记录的适配器健康评分（无样本时不返回）
  'agent:getHealth': () => Promise<AdapterHealthScore[]>
  'agent:verify': (params: {
    nodeId: string
    acceptanceCriteria: string[]
    messages: ChatMessage[]
    fileChanges: AgentOutput[]
    workingDirectory?: string
  }) => Promise<VerificationReport>

  'agent:getLogsByNode': (nodeId: string) => Promise<AgentLog[]>
  'agent:getLogsByGraph': (graphId: string) => Promise<AgentLog[]>
  'agent:closeAllSessions': () => Promise<void>

  // Agent Runtime M0（D2–D5）
  'agent:cancelTurn': (turnId: string) => Promise<boolean>
  'agent:getPendingApprovals': () => Promise<ApprovalRequestPayload[]>
  'agent:resolveApproval': (input: ApprovalDecisionInput) => Promise<{
    approvalId: string
    decision: 'allow' | 'deny'
    decidedBy: string
    sessionGranted: boolean
    grantSourceApprovalId?: string
  }>
  'agent:getExecutorCapabilities': (executor: string) => Promise<DriverCapabilities>
  'agent:getSessionRecovery': (sessionId: string) => Promise<SessionRecoveryInfo | null>
  /** A1：Kernel 路径开关（默认 false，权威来自主进程环境变量） */
  'agent:getRuntimeFlags': () => Promise<AgentRuntimeFlags>
  /** A1：按 adapter session 取消当前未终态 turn */
  'agent:cancelSessionTurn': (sessionId: string) => Promise<boolean>
  /** A2：列出当前进程内的会话级授权 */
  'agent:getSessionGrants': () => Promise<SessionGrantInfo[]>
  /** A2：手动撤销某会话的授权 */
  'agent:revokeSessionGrant': (sessionId: string) => Promise<boolean>
  /** M1：会话用量（provider/estimated/unknown 与缺价行计数 + 明细） */
  'agent:getUsageBySession': (sessionId: string, limit?: number) => Promise<SessionUsageView>
  /** M1：图级按日用量（day_key 为 Asia/Shanghai 本地日，原样返回） */
  'agent:getUsageByGraph': (graphId: string, days?: number) => Promise<GraphUsageView>
  /** P0-2：事件存储统计（行数/占用估算/时间跨度；不触发 VACUUM） */
  'agent:getStorageStats': () => Promise<AgentStorageStats>

  // Chat 会话记录
  'thread:list': (filters?: { nodeId?: string; graphId?: string }) => Promise<AgentThread[]>
  'thread:load': (threadId: string) => Promise<AgentThread | null>
  'thread:create': (data: { adapterName: string; nodeId?: string; graphId?: string }) => Promise<AgentThread>
  'thread:update': (threadId: string, data: { title?: string; status?: string; sessionId?: string }) => Promise<void>
  'thread:delete': (threadId: string) => Promise<void>
  'thread:search': (query: string) => Promise<AgentThread[]>

  'message:list': (threadId: string, limit?: number, offset?: number) => Promise<ChatMessage[]>
  'message:save': (threadId: string, message: ChatMessage) => Promise<void>
  'message:saveBatch': (threadId: string, messages: ChatMessage[]) => Promise<void>

  'chat:archiveStale': (projectId: string, staleDays?: number) => Promise<number>

  // Chat 归档清理
  'chat:cleanupArchived': () => Promise<number>

  // Context waterline (Phase 2)
  'context:getWaterline': (threadId: string) => Promise<ContextState | null>
  'context:listHistory': (threadId: string) => Promise<CompactHistoryEntry[]>
  'context:compactNow': (sessionId: string, strategy?: CompactStrategy) => Promise<CompactResult>

  // 文件系统
  'fs:readDir': (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
  'fs:readDirDetail': (path: string) => Promise<{ name: string; path: string; isDirectory: boolean; size: number; mtimeMs: number }[]>
  'fs:readFile': (path: string) => Promise<string>
  'fs:createFile': (filePath: string) => Promise<{ path: string; name: string }>
  'fs:createDir': (dirPath: string) => Promise<{ path: string; name: string }>
  'fs:delete': (targetPath: string, recursive?: boolean) => Promise<{ deleted: string }>
  'fs:rename': (oldPath: string, newName: string) => Promise<{ oldPath: string; newPath: string; newName: string }>
  'fs:move': (sourcePath: string, destDir: string) => Promise<{ sourcePath: string; destPath: string; name: string }>
  'fs:copy': (sourcePath: string, destDir: string) => Promise<{ sourcePath: string; destPath: string; name: string }>
  'fs:exists': (targetPath: string) => Promise<boolean>
  'fs:stat': (targetPath: string) => Promise<{ isDirectory: boolean; isFile: boolean; size: number; mtimeMs: number; ctimeMs: number }>
  'fs:registerProjectPaths': (paths: string[]) => Promise<void>
  'fs:searchFiles': (dirPath: string, query: string, limit?: number) => Promise<FileSearchResult[]>

  // Git 操作
  'git:status': (path: string) => Promise<{ modified: string[]; untracked: string[] }>
  'git:diff': (path: string) => Promise<string>
  'git:commit': (path: string, message: string, files: string[]) => Promise<void>

  // Dialog 操作
  'dialog:openDirectory': () => Promise<string | null>
  'dialog:openFiles': (options?: { extensions?: string[] }) => Promise<string[]>

  // 项目扫描
  'project:scan': (projectPath: string) => Promise<ProjectScanResult>

  // 从项目初始化图（§9.2 confirm：allowed_branch/remember_for_fingerprint 由用户显式勾选）
  'graph:initFromProject': (data: {
    projectPath: string
    projectName: string
    allowBranchVariant?: boolean
    rememberForFingerprint?: boolean
  }) => Promise<{
    onlineGraph: Graph
    devGraph: Graph
    modules: ScanModule[]
    threadId?: string
  }>

  // §9.2 导入预览：返回指纹命中证据（相似度/判定/是否命中记住规则），不写库
  'project:import:preview': (data: { projectPath: string; projectName?: string }) => Promise<{
    decision: { action: string; step: string; reason: string }
    signals: Record<string, unknown>
    dirName: string
  }>

  // S1 导入查重：记住的分支/副本放行规则（§2.6 规则 7,可查看/可撤销）
  'project:import:allowance:list': () => Promise<Array<Record<string, unknown>>>
  'project:import:allowance:revoke': (id: string, revokedBy?: string) => Promise<void>

  // S2 跨图链接：人工创建（L1 仅 relates_to,§8.4）+ 巡检手动触发（§2.3.1）
  'map:link:create': (data: {
    projectPath: string
    fromEntityKey: string
    fromGraphId: string
    toEntityKey: string
    toGraphId: string
    linkType?: string
    reason?: string
  }) => Promise<{ outcome: 'created' | 'reused' | 'revived'; row: Record<string, unknown> }>
  'admin:map:integrity-check': () => Promise<{ checked: number; orphans: number; staled: number }>

  // S5a/S6a L1 通道（§9.2）
  /** 叠加层批量查询：一次返回全图派生态+当前任务摘要（禁止按节点轮询） */
  'map:overlay:get': (graphId: string) => Promise<{ executionStates: Array<Record<string, unknown>>; workItems: Array<Record<string, unknown>> }>
  'map:link:list': (query: { projectPath: string; entityKey?: string }) => Promise<Array<Record<string, unknown>>>
  /** 节点会话时间线（§9.5-3:替代单线程映射,UI 保留 threadIds 全集） */
  'map:node:timeline': (query: { graphId: string; nodeEntityKey: string; limit?: number }) => Promise<Array<Record<string, unknown>>>
  'map:node:evidence:list': (query: { graphId: string; nodeEntityKey: string }) => Promise<Array<Record<string, unknown>>>
  /** 证据建议只读列表（§3.4）：可按节点/状态过滤，默认只看 pending。 */
  'map:evidence:suggestions:list': (query: {
    graphId: string
    nodeEntityKey?: string
    status?: 'pending' | 'accepted' | 'dismissed'
    limit?: number
  }) => Promise<Array<Record<string, unknown>>>
  /** 接受建议（写通道）：同一事务内转写 node_evidence。幂等键 = 建议 id。 */
  'map:evidence:suggestion:accept': (data: { id: string; resolvedBy: string }) => Promise<{
    suggestion: Record<string, unknown>
    evidenceId: string
    reused: boolean
  }>
  /** 驳回建议（写通道）：只改状态、不写证据。幂等键 = 建议 id。 */
  'map:evidence:suggestion:dismiss': (data: { id: string; resolvedBy: string }) => Promise<Record<string, unknown>>
  /**
   * E1 人工判断直写（写通道，G3-10）：等级/写入方由主进程固定为 E1/human，
   * 不接受调用方自报 `actor`/`producedBy`。`ref` 指向被判断对象；可选
   * `idempotencyKey` 保证重复提交返回既有证据（`reused=true`）。renderer 入口归 G8。
   */
  'map:evidence:e1:create': (data: {
    graphId: string
    nodeEntityKey: string
    nodeId?: string
    projectPath?: string
    summary: string
    ref: unknown
    idempotencyKey?: string
  }) => Promise<{ evidenceId: string; reused: boolean; row: Record<string, unknown> }>
  /** item 下钻：item + 当前 revision 的 steps + 该 item 全部 runs */
  'workitem:get': (id: string) => Promise<{ item: Record<string, unknown>; steps: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>> } | null>
  'workitem:list': (query: { graphId: string; anchorEntityKey?: string; includeHistory?: boolean; limit?: number }) => Promise<Array<Record<string, unknown>>>
  /** step 只读列表（工作项下钻；含 v34 skip_reason / failure_class） */
  'workitem:steps:list': (query: { workItemId: string; revision?: number; limit?: number }) => Promise<Array<Record<string, unknown>>>
  /** 证据只读列表（按 work_item 下钻；节点维度走 map:node:evidence:list） */
  'workitem:evidence:list': (query: { workItemId: string; limit?: number }) => Promise<Array<Record<string, unknown>>>
  /** run 只读列表：workItemId / stepId / graphId 至少给一个，limit 1..500 */
  'map:run:list': (query: {
    workItemId?: string
    stepId?: string
    graphId?: string
    status?: string
    limit?: number
  }) => Promise<Array<Record<string, unknown>>>
  'map:run:get': (id: string) => Promise<Record<string, unknown> | null>
  /**
   * L2 执行开关只读状态：renderer 据此禁用执行入口并解释「为什么入队后不会跑」。
   * 不触发任何执行，也不落库。
   */
  'map:execution:status': () => Promise<{
    enabled: boolean
    adapterName: string | null
    disabledReason: string | null
    /**
     * G7-8：pinned adapter 的能力票（Tier 1 才允许写编排）。
     * 未探测（执行未开启 / 无服务）时为 null。
     */
    tier?: 1 | 2 | 3 | null
    /** 能力票缺项（例如 `resume`、`probe_error:DRIVER_MISSING`），用于 UI 解释。 */
    tierMissing?: string[]
  }>
  /**
   * G2-13 只读：test 图 test-case 的发布徽标与统计。
   * 只读查询，不改变发布状态；徽标不替代人工发布确认。
   */
  'map:published:status': (graphId: string) => Promise<{
    graphId: string
    total: number
    published: number
    verified: number
    publishedWithoutEvidence: number
    nodes: Array<{
      id: string
      entityKey: string | null
      title: string
      status: string
      hasPassEvidence: boolean
      badge: 'verified' | 'unverified' | null
      lastTestStatus: string | null
      lastTestFailed: boolean
    }>
  }>
  /**
   * G5-10 只读：项目进度聚合（节点总数 / 已验证节点 / 任务完成与失败 / 证据分级）。
   * 项目无数据时返回 `available=false` 与零值，不报错、不阻塞任务查询。
   */
  'map:project:progress': (projectPath: string) => Promise<{
    projectPath: string
    available: boolean
    nodesTotal: number
    nodesVerified: number
    itemsDone: number
    itemsFailed: number
    evidenceByLevel: Record<string, number>
  }>
  'workitem:create': (data: {
    projectPath?: string
    graphId: string
    anchorEntityKey?: string
    anchorNodeId?: string
    title: string
    goal?: string
    scopeFiles?: string[]
    acceptance?: Array<Record<string, unknown>>
    steps?: Array<{ title: string; stepKind?: 'agent' | 'test' | 'human' }>
    createdBy?: string
  }) => Promise<Record<string, unknown>>
  'workitem:revise': (data: { id: string; title?: string; goal?: string; scopeFiles?: string[]; acceptance?: Array<Record<string, unknown>> }) => Promise<Record<string, unknown>>
  /** run:start 前必须 gate=pass/waived（§9.2）;编排执行随 L2 §5.9 */
  'workitem:run:start': (data: { id: string; gateResult?: 'pass' | 'waived'; waivedBy?: string; waiveReason?: string }) => Promise<Record<string, unknown>>
  'workitem:cancel': (id: string) => Promise<Record<string, unknown>>

  /** G2-1 执行模式（只读）：返回代码常量 mode-registry 的副本。 */
  'mode:list': () => Promise<Array<Record<string, unknown>>>
  /**
   * G1-14 提案（只读）：默认排除 done/cancelled/superseded；weight 仅影响展示排序。
   * 提案存放在 work_items，本通道只 SELECT `v_online_proposals`。
   */
  'proposal:list': (query: {
    graphId?: string
    anchorEntityKey?: string
    includeResolved?: boolean
    limit?: number
  }) => Promise<Array<Record<string, unknown>>>
  /** G1-14 提案 diff（只读）：返回解析后的 before/after 与 stale 判定。 */
  'proposal:diff': (id: string) => Promise<Record<string, unknown> | null>
  /** G1-14 提案创建（写通道）：只写 work_items，不写 online 图。 */
  'proposal:create': (data: {
    projectPath?: string
    graphId: string
    anchorEntityKey: string
    anchorNodeId?: string
    title: string
    reason: string
    before?: unknown
    after: unknown
    evidenceRefs?: string[]
    baseRevision?: string
    conflictGroup?: string
    weight?: number
    createdBy?: string
  }) => Promise<Record<string, unknown>>
  /** G1-14 提案采纳（写通道）：只收口提案状态；online 图由人工先行编辑。 */
  'proposal:accept': (data: { id: string; acceptedBy: string }) => Promise<{ proposal: Record<string, unknown>; reused: boolean }>
  /** G1-14 提案驳回（写通道）：理由必填。 */
  'proposal:reject': (data: { id: string; reason: string; rejectedBy?: string }) => Promise<{ proposal: Record<string, unknown>; reused: boolean }>

  /** L2 执行触发（写通道；默认关闭，需 BIZGRAPH_MAP_EXECUTION=1）。只入队，不内联跑 turn。 */
  'workitem:step:run': (data: {
    stepId: string
    adapterName: string
    workItemId?: string
    deadlineAt?: number
  }) => Promise<{ runId: string; stepId: string; status: string; reused: boolean }>
  /** run 取消：queued/running 条件更新；完成竞态失败方保留。 */
  'workitem:run:cancel': (runId: string) => Promise<{
    runId: string
    status: string
    cancelled: boolean
    alreadyTerminal: boolean
    itemStatus?: string
  }>
  /**
   * manual 验收人工确认：记录确认事实并重算验收。
   * 部分确认允许（entryIds 子集）；全部通过则步/item 收口。
   */
  'workitem:acceptance:confirm': (data: {
    stepId?: string
    workItemId?: string
    entryIds: string[]
    note?: string
    confirmedBy?: string
  }) => Promise<{
    stepId: string
    workItemId: string
    stepStatus: string
    itemStatus: string
    remainingEntryIds: string[]
    /** 本次确认事实批次 id（acceptance_confirmations.batch_id）。 */
    confirmationBatchId: string
    /** 本次写入的确认事实行 id（每个条目一行）。 */
    confirmationIds: string[]
  }>

  // S7 计划推导/草稿（§9.2 plan:*;C1 环检测拒绝带 |cycle=[...] 后缀）
  'plan:derive-candidates': (data: { graphId: string; anchorNodeId?: string; changeFiles?: string[] }) => Promise<{
    runId: string
    degraded: false | string
    candidates: Array<Record<string, unknown>>
  }>
  'plan:draft:create': (data: { projectPath?: string; graphId: string; anchorEntityKey?: string; anchorNodeId?: string; derivationRunId?: string; items: Array<Record<string, unknown>> }) => Promise<Record<string, unknown>>
  'plan:draft:get': (id: string) => Promise<Record<string, unknown> | null>
  'plan:draft:revise': (data: { id: string; items: Array<Record<string, unknown>> }) => Promise<Record<string, unknown>>
  'plan:draft:confirm': (data: { id: string; confirmedBy?: string }) => Promise<{ draft: Record<string, unknown>; workItemIds: string[]; parentId: string }>
  'plan:draft:reject': (id: string) => Promise<Record<string, unknown>>

  // 配置管理
  'settings:read': () => Promise<BizGraphSettings>
  // 只提交需要变更的字段即可；主进程与当前设置做顶层合并后再落盘。
  'settings:write': (settings: Partial<BizGraphSettings>) => Promise<void>
  'settings:refreshCli': () => Promise<CliToolConfig[]>
  'settings:installCli': (name: string) => Promise<{ success: boolean; message: string }>
  'settings:setApiKey': (provider: string, key: string, baseUrl?: string | null) => Promise<void>
  'settings:getAdapterPreferences': () => Promise<AdapterPreferences>
  'settings:setAdapterPreferences': (prefs: AdapterPreferences) => Promise<void>
  'settings:getContextWaterlineConfig': () => Promise<{ autoCompactEnabled: boolean; autoCompactThreshold: number; minCompactInterval: number }>
  'settings:setContextWaterlineConfig': (cfg: { autoCompactEnabled?: boolean; autoCompactThreshold?: number; minCompactInterval?: number }) => Promise<void>

  // MindMap Agent 操作
  'mindmap:generate': (projectPath: string) => Promise<ScanModule[]>
  'mindmap:generateModule': (projectPath: string, parentNodeId: string, parentNodeTitle: string, parentNodeType: NodeType) => Promise<{ childType: NodeType; children: Array<{ title: string; description?: string }> }>
  'mindmap:enrichNode': (projectPath: string, nodeId: string, nodeType: NodeType, nodeTitle: string, relatedFiles?: string[], contextRefs?: ContextRef[]) => Promise<NodeEnrichment>
  'mindmap:refine': (projectPath: string, scope: 'project' | 'module' | 'node', targetId: string, feedback: string) => Promise<ScanModule[] | ScanModule | NodeEnrichment>
  'mindmap:buildDevPrompt': (nodeId: string, nodeTitle: string, nodeType: NodeType, taskType: 'feature' | 'bugfix' | 'refactor', graphId: string, contextRefs?: ContextRef[]) => Promise<string>

  // 代码智能操作
  'codeIntel:indexProject': (projectPath: string) => Promise<{ filesIndexed: number; symbolsFound: number; importsFound: number }>
  'codeIntel:querySymbols': (name: string, options?: { kind?: SymbolKind; fuzzy?: boolean; limit?: number }) => Promise<SymbolQueryResult[]>
  'codeIntel:getRelatedFiles': (filePath: string, depth?: number) => Promise<Array<{ filePath: string; distance: number }>>
  'codeIntel:generatePlan': (userQuery: string) => Promise<CodeIntelExecutionPlan>

  // Memory 记忆操作
  'memory:search': (query: string, options?: { projectId?: string; kind?: MemoryKind; limit?: number }) => Promise<MemoryItem[]>
  'memory:getRecent': (options?: { projectId?: string; nodeId?: string; limit?: number }) => Promise<MemoryItem[]>
  'memory:getByNode': (nodeId: string, limit?: number) => Promise<MemoryItem[]>
  'memory:getBySession': (sessionId: string, limit?: number) => Promise<MemoryItem[]>
  'memory:getStats': (projectId?: string) => Promise<Array<{ kind: string; count: number }>>
  'memory:getCrossAdapter': (projectId: string, excludeAdapter: string, limit?: number) => Promise<MemoryItem[]>
  /**
   * 删除会话记忆。必须同时提供 projectId 作为授权范围，
   * 防止仅凭 sessionId 跨项目删除——与 main 侧 deleteBySessionScoped 对齐。
   */
  'memory:delete': (sessionId: string, projectId: string) => Promise<number>
  'memory:prune': (daysThreshold?: number) => Promise<number>
  'memory:getEvolutionChain': (concept: string, projectId: string) => Promise<MemoryItem[]>
  'memory:backfillEmbeddings': (projectId: string) => Promise<number>
  'memory:pruneWithDecay': (projectId: string, config?: { baseHalfLife?: number; minConfidence?: number; maxItems?: number }) => Promise<number>

  // Agent 模式管理
  'mode:getCurrent': (projectId: string) => Promise<AgentMode>
  'mode:setCurrent': (projectId: string, mode: AgentMode) => Promise<void>
  'mode:getAvailable': () => Promise<AgentModeConfig[]>

  // ScopeGuard 操作
  'scopeGuard:rollbackFile': (sessionId: string, filePath: string) => Promise<boolean>
  'scopeGuard:commitSession': (sessionId: string) => Promise<ValidationResult>
  'scopeGuard:rollbackSession': (sessionId: string) => Promise<void>

  // Subagent dispatch (Phase 4)
  'subagent:listTypes': () => Promise<AgentTypeDefinition[]>
  'subagent:listInvocations': (parentSessionId: string) => Promise<SubagentInvocation[]>
  'subagent:cancel': (invocationId: string) => Promise<void>
  'subagent:getResult': (invocationId: string) => Promise<SubagentResult | null>

  // Recipes (Phase C — YAML shareable workflows)
  'recipes:list': () => Promise<RecipeDefinition[]>
  'recipes:get': (id: string) => Promise<RecipeDefinition | null>
  'recipes:dag': (id: string) => Promise<RecipeDag>
  'recipes:run': (request: RecipeRunRequest) => Promise<RecipeRun>
  'recipes:cancel': (runId: string) => Promise<boolean>
  'recipes:refresh': () => Promise<number>
  'recipes:listRuns': (recipeId: string, limit?: number) => Promise<RecipeRun[]>
  'recipes:getRun': (runId: string) => Promise<RecipeRun | null>

  // D10b: realtime (awareness / user identity)
  'realtime:getIdentity': () => Promise<UserIdentity>
  'realtime:setIdentity': (patch: Partial<Pick<UserIdentity, 'userName' | 'colorIndex'>>) => Promise<UserIdentity>
  'realtime:getConnectionInfo': () => Promise<RealtimeConnectionInfo>

  // Realtime conflict resolution (D10d)
  'conflict:getRecentReports': (graphId: string, limit?: number) => Promise<ConflictReport[]>
  'conflict:clearReports': (graphId: string) => Promise<void>

  // A2A (Phase D9 — cross-process agent protocol)
  /** Snapshot of A2A server lifecycle + task-store counters. */
  'a2a:getServerStatus': () => Promise<A2AServerStatus>
  /** Start the configured A2A server (idempotent if already running). */
  'a2a:startServer': () => Promise<{ success: boolean; port?: number; error?: string }>
  /** Stop the running A2A server (no-op if already stopped). */
  'a2a:stopServer': () => Promise<{ success: boolean }>
  /** Test reachability of a remote A2A agent by name. */
  'a2a:testConnection': (name: string) => Promise<{ ok: boolean; card?: A2AAgentCard; error?: string; latencyMs: number }>
  /** List configured remote A2A agents (apiKey fields masked). */
  'a2a:listRemoteAgents': () => Promise<A2ARemoteAgent[]>
  /** Persist (create or replace) a remote A2A agent. apiKey preserved if already masked. */
  'a2a:saveRemoteAgent': (agent: A2ARemoteAgent) => Promise<{ success: boolean; error?: string }>
  /** Delete a remote A2A agent by name. */
  'a2a:deleteRemoteAgent': (name: string) => Promise<{ success: boolean }>
  /** Validate A2AServerConfig shape before save (port range, bindAddress, apiKey length). */
  'a2a:testServerConfig': (cfg: A2AServerConfig) => Promise<{ valid: boolean; errors: string[] }>
}

/**
 * Push-only event channels.
 *
 * These are not exposed via `ipcRenderer.invoke`; they are delivered from the
 * main process through dedicated `ipcRenderer.on` listeners exposed by the
 * preload script (e.g. `onAgentOutput`, `onAgentStatusChange`).
 */
export interface IpcEventMap {
  'agent:onOutput': (sessionId: string, output: AgentOutput) => void
  'agent:onApprovalRequest': (payload: ApprovalRequestPayload) => void
  'agent:onApprovalResolved': (payload: ApprovalResolutionPayload) => void
  'agent:onEvent': (event: NormalizedEventEnvelope) => void
  'agent:onStatusChange': (sessionId: string, nodeId: string, status: NodeStatus) => void
  'agent:onSessionStarted': (threadId: string, sessionId: string) => void
  'event:NODE_STATUS_CHANGE': (nodeId: string, oldStatus: string, newStatus: string) => void
  'session:recovered': (sessionId: string, newSessionId: string) => void
  'session:recoveryFailed': (sessionId: string, reason: string) => void
  'waterline:change': (state: ContextState) => void
  'subagent:progress': (data: { invocationId: string; status: string; error?: string; partialSummary?: SubagentPartialSummary }) => void
  'recipe:run:progress': (data: RecipeRunProgressEvent) => void
  'menu:openProject': (projectPath: string) => void
  'conflict:onReported': (report: ConflictReport) => void
  /** A2A server lifecycle change (start/stop/restart). Carries the same payload as `a2a:getServerStatus`. */
  'a2a:serverStatusChange': (status: A2AServerStatus) => void
}

/**
 * session-map 只读通道白名单（preload 暴露 + 测试断言共用唯一来源）。
 *
 * 约束：只允许 `SELECT`/派生缓存读。不得加入任何写操作或执行触发
 * （enqueue / claim / start / cancel / approve / create / revise / plan 确认等）。
 */
export const MAP_READ_ONLY_CHANNELS = [
  'map:overlay:get',
  'map:link:list',
  'map:node:timeline',
  'map:node:evidence:list',
  'map:evidence:suggestions:list',
  'workitem:get',
  'workitem:list',
  'workitem:steps:list',
  'workitem:evidence:list',
  'map:run:list',
  'map:run:get',
  'map:execution:status',
  'map:published:status',
  'map:project:progress',
  'mode:list',
  'proposal:list',
  'proposal:diff',
] as const satisfies readonly (keyof IpcApi)[]
