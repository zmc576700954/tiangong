/**
 * BizGraph 核心类型定义
 * 共享于主进程与渲染进程之间
 */

// Note: Do NOT import Node.js-specific types here.
// This file is shared between main and renderer processes.
// ChildProcess and other Node.js runtime objects must not appear in serializable types.

// ============================================
// 节点相关类型
// ============================================

/** 节点状态 */
export type NodeStatus =
  | 'draft'        // 草稿（灰色）
  | 'confirmed'    // 已确认（蓝色）
  | 'developing'   // 开发中（橙色）
  | 'testing'      // 待测试（紫色）
  | 'review'       // 待验收（青色）
  | 'published'    // 已发布（绿色）
  | 'placeholder'  // 占位节点（虚线灰色）

/** 思维导图中显示的节点类型 */
export type NodeType =
  | 'project'      // 项目根节点
  | 'module'       // 业务模块
  | 'process'      // 业务流程
  | 'feature'      // 功能点（仅开发场景）
  | 'bug'          // BUG点（仅开发场景）

/** 图类型：每个项目只有两张图 */
export type GraphType = 'online' | 'dev'

/** 边类型 */
export type EdgeType = 'default' | 'success' | 'failure' | 'condition' | 'business-flow'

/** 业务规则（作为流程节点的属性） */
export interface BusinessRule {
  id: string
  title: string
  description: string
  condition: string   // 触发条件
  action: string      // 执行动作
}

/** 文件/方法关联 */
export interface FileAssociation {
  path: string
  type: 'file' | 'directory' | 'method'
  methodName?: string
  description?: string
}

/** 节点元数据（API/服务/实体） */
export interface NodeMetadata {
  apis?: { name: string; method?: string; path?: string; description?: string }[]
  services?: { name: string; description?: string }[]
  entities?: { name: string; fields?: string; description?: string }[]
  fileAssociations?: FileAssociation[]
}

/** 节点详细内容（图谱内部存储，不直接展示在画布） */
export interface NodeContent {
  /** 完整业务描述 */
  fullDescription: string
  /** 业务规则列表 */
  businessRules?: BusinessRule[]
  /** 验收标准 */
  acceptanceCriteria?: string[]
  /** 实现要点 */
  implementationNotes?: string[]
  /** 关联文件路径 */
  relatedFiles?: string[]
  /** 关键函数/类签名 */
  codeSignatures?: string[]
}

/** 节点数据 */
export interface GraphNode {
  id: string
  type: NodeType
  status: NodeStatus
  title: string
  description?: string
  /** 验收标准 */
  acceptanceCriteria?: string[]
  /** 所属图 */
  graphId: string
  graphType: GraphType
  /** 父节点 ID（层级结构：模块 -> 流程 -> 功能点/BUG） */
  parentId?: string
  /** 业务规则（仅流程节点） */
  rules?: BusinessRule[]
  /** 元数据（API/服务/实体） */
  metadata?: NodeMetadata
  /** 节点详细内容（图谱内部存储） */
  content?: NodeContent
  /** 预计算的社区摘要 */
  communitySummary?: string
  /** 所属社区层级 0=项目级 1=模块级 2=流程级 */
  communityLevel?: number
  /** 节点关联的上下文（文件/文本/其他节点） */
  contextRefs?: ContextRef[]
  /** 节点所有者角色 */
  ownerRole?: 'product' | 'developer' | 'tester'
  /** 在画布上的位置 */
  position: { x: number; y: number }
  /** 创建/更新时间 */
  createdAt: string
  updatedAt: string
}

/** 边的业务内容 */
export interface EdgeContent {
  condition?: string
  note?: string
}

/** 边（连接） */
export interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  graphId: string
  /** 边类型（用于流程逻辑可视化） */
  edgeType?: EdgeType
  /** 关系业务描述（如"用户下单后触发库存扣减"） */
  description?: string
  /** 数据流向描述（如"传递 orderId, amount"） */
  dataFlow?: string
  /** 关系强度 0-1（影响检索排序） */
  strength?: number
  /** 边业务内容（条件、备注等） */
  content?: EdgeContent
}

/** 图定义 */
export interface Graph {
  id: string
  name: string
  type: GraphType
  /** 项目根目录 */
  projectPath?: string
  createdAt: string
  updatedAt: string
}

// ============================================
// Bug 相关类型（开发场景中的BUG节点）
// ============================================

export type BugSeverity = 'low' | 'medium' | 'high' | 'critical'
export type BugStatus = 'open' | 'fixed' | 'verified'

export interface BugNode {
  id: string
  title: string
  description: string
  severity: BugSeverity
  status: BugStatus
  /** 关联的开发节点 ID */
  nodeId: string
  /** 关联的开发图 ID */
  graphId: string
  createdAt: string
  updatedAt: string
}

// ============================================
// Agent 适配器类型（核心扩展点）
// ============================================

/** Agent 范围上下文 */
export interface AgentSessionConfig {
  /** 项目根目录 */
  workingDirectory: string
  /** 白名单: 只能改这些文件 */
  allowedFiles: string[]
  /** 黑名单: 绝对不能碰 */
  forbiddenFiles: string[]
  /** 业务不变量提示 */
  invariantRules: string[]
  /** 上游节点契约说明 */
  upstreamContext: string
  /** 下游节点契约说明 */
  downstreamContext: string
  /** 当前业务节点名称 */
  nodeTitle: string
  /** 验收标准 */
  acceptanceCriteria: string[]
  /** 如果是修复 Bug，传入 Bug 详情 */
  bugContext?: BugContext[]
  /** Claude Code 会话续接 ID，非空时 spawn 命令加 --resume */
  resumeSessionId?: string
  /** 关联的节点 ID（用于状态同步） */
  nodeId?: string
}

export interface BugContext {
  bugId: string
  title: string
  description: string
  severity: BugSeverity
}

/** Agent 指令类型 */
export type AgentCommandType = 'implement' | 'fix_bug' | 'refactor' | 'add_test'

/** Agent 指令 */
export interface AgentCommand {
  type: AgentCommandType
  /** 自然语言描述 */
  description: string
  /** 目标节点 ID */
  targetNodeId: string
}

/** Agent 输出 */
export interface AgentOutput {
  type: 'stdout' | 'stderr' | 'file_change' | 'error' | 'complete'
  data: string
  timestamp: number
  /** 如果是 file_change，记录变更的文件路径 */
  filePath?: string
  /** 如果是 file_change，记录变更类型 */
  changeType?: 'add' | 'modify' | 'delete'
  /** 错误分类码 */
  errorCode?: string
}

/** 上下文引用（节点、文件或自由文本） */
export interface ContextRef {
  type: 'node' | 'file' | 'text'
  id: string
  label: string
  /** 文本类型的内容（type='text' 时必填） */
  content?: string
  /** 上下文来源 */
  source?: 'user-attach' | 'right-click' | 'mention' | 'auto-scope'
}

/** 已解析的上下文（含实际内容，用于注入 prompt） */
export interface ResolvedContext {
  type: 'node' | 'file' | 'text'
  id: string
  label: string
  content: string
  tokenEstimate: number
}

/** 文件搜索结果（用于 @ 提及文件） */
export interface FileSearchResult {
  name: string
  relativePath: string
  isDirectory: boolean
}

/** 工具调用块（嵌入 Agent 消息中） */
export interface ToolCallBlock {
  type: 'file_edit' | 'diff' | 'terminal' | 'file_create'
  filePath?: string
  content: string
  status: 'running' | 'done' | 'error'
  accepted?: boolean
}

/** 消息状态 */
export type MessageStatus =
  | 'pending'     // 用户消息刚发出，等待 agent 响应
  | 'streaming'   // agent 正在输出
  | 'success'     // agent 正常完成
  | 'error'       // 出错
  | 'aborted'     // 用户主动终止

/** 消息错误信息 */
export interface MessageError {
  code: string       // 错误码，如 AGENT_CRASH、SESSION_START_FAILED 等
  message: string    // 用户可读的错误描述
  raw?: string       // 原始错误数据（可选，用于调试）
}

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: 'user' | 'agent' | 'system'
  content: string
  timestamp: number
  adapterName?: string
  toolCalls?: ToolCallBlock[]
  contextRefs?: ContextRef[]
  status: MessageStatus
  error?: MessageError
  sessionId?: string
}

/** Agent 会话线程 */
export interface AgentThread {
  id: string
  title: string
  adapterName: string
  messages: ChatMessage[]
  contextRefs: ContextRef[]
  status: 'idle' | 'running' | 'error' | 'reviewed'
  createdAt: number
  nodeBound?: string
  sessionId?: string
}

/** Agent 会话（可序列化，不含 Node.js 运行时对象） */
export interface AgentSession {
  id: string
  /** 进程 PID（运行时通过适配器内部 Map 关联到真实进程） */
  pid?: number
  adapterName: string
  config: AgentSessionConfig
  startTime: number
  /** 运行时注入的已解析上下文（不持久化） */
  resolvedContexts?: ResolvedContext[]
  /** Fallback 信息：当请求适配器未安装，回退到 MCP 时记录 */
  fallbackInfo?: {
    originalAdapter: string
    fallbackReason: string
  }
}

/** Agent 适配器接口 */
export interface AgentAdapter {
  /** 适配器名称 */
  name: string
  /** 适配器版本 */
  version: string

  /** 检测用户系统是否已安装该 Agent */
  checkInstalled(): Promise<boolean>

  /** 启动 Agent 会话，注入范围上下文 */
  startSession(config: AgentSessionConfig): Promise<AgentSession>

  /** 发送指令 */
  sendCommand(sessionId: string, command: AgentCommand): Promise<void>

  /** 监听输出流 */
  onOutput(handler: (output: AgentOutput) => void): void

  /** 移除输出流监听 */
  offOutput(handler: (output: AgentOutput) => void): void

  /** 终止会话 */
  terminateSession(sessionId: string): Promise<void>

  /** 解析输出关联的 sessionId（由 BaseAdapter 实现，用于精准广播） */
  resolveOutputSession?(output: AgentOutput): string | undefined

  /** 设置会话的已解析上下文（供 AgentManager 注入上下文） */
  setResolvedContexts(sessionId: string, contexts: ResolvedContext[]): void

  /** 监听会话结束事件（BaseAdapter 继承 EventEmitter 提供） */
  on(event: 'sessionEnded', handler: (sessionId: string, reason: 'success' | 'crash' | 'error') => void): void

  /** 移除会话结束事件监听 */
  off(event: 'sessionEnded', handler: (sessionId: string, reason: 'success' | 'crash' | 'error') => void): void
}

// ============================================
// 范围守卫类型
// ============================================

/** 沙箱（可序列化，不含运行时对象） */
export interface Sandbox {
  id: string
  workingDir: string
  backupDir: string
  allowedFiles: string[]
}

export interface ValidationResult {
  compliant: boolean
  /** 越界文件列表 */
  outOfBoundsFiles: string[]
  /** 合规文件列表 */
  validFiles: string[]
  /** 是否需要回滚 */
  shouldRollback: boolean
  /** 新增文件列表（用于回滚时删除） */
  newFiles?: string[]
}

// ============================================
// 快照类型
// ============================================

export interface GraphSnapshot {
  id: string
  graphId: string
  name: string
  /** 序列化的节点和边数据 */
  data: {
    nodes: GraphNode[]
    edges: GraphEdge[]
  }
  /** Git commit hash（如果有关联） */
  gitCommit?: string
  createdAt: string
}

// ============================================
// Agent 执行日志
// ============================================

export interface AgentLog {
  id: string
  sessionId: string
  adapterName: string
  nodeId: string
  graphId: string
  command: AgentCommand
  outputs: AgentOutput[]
  /** 执行结果 */
  result: 'success' | 'failure' | 'cancelled'
  /** 执行耗时（毫秒） */
  duration: number
  createdAt: string
}

// ============================================
// 项目扫描类型
// ============================================

export interface ScanFeature {
  name: string
  description: string
  type: 'feature' | 'bug'
}

export interface ScanProcess {
  name: string
  description: string
  features: ScanFeature[]
}

export interface ScanModule {
  name: string
  description: string
  processes: ScanProcess[]
}

export interface PackageJsonInfo {
  name: string
  description: string
  version: string
  scripts?: Record<string, string>
  dependencies: string[]
  devDependencies: string[]
}

export interface ProjectScanResult {
  projectName: string
  projectPath: string
  framework: string
  packageJson: PackageJsonInfo | null
  modules: ScanModule[]
}

// ============================================
// MindMap Agent 相关类型
// ============================================

/** 社区摘要（GraphRAG 分层摘要） */
export interface CommunitySummary {
  id: string
  graphId: string
  /** 社区层级：0=项目级, 1=模块级, 2=流程级 */
  level: number
  /** 包含的节点 ID */
  nodeIds: string[]
  /** 社区标题（如"用户管理域"） */
  title: string
  /** 社区摘要 */
  summary: string
  /** 关键发现列表（用于 map-reduce） */
  keyFindings: string[]
}

/** 节点深化结果 */
export interface NodeEnrichment {
  /** 深化的业务描述 */
  description: string
  /** 验收标准 */
  acceptanceCriteria?: string[]
  /** 业务规则 */
  businessRules?: BusinessRule[]
  /** 元数据 */
  metadata?: NodeMetadata
  /** 关联文件路径 */
  relatedFiles?: string[]
  /** 实现要点 */
  implementationHints?: string[]
  /** 关键函数/类签名 */
  codeSignatures?: string[]
}

/** 精炼历史记录 */
export interface RefinementRecord {
  timestamp: string
  scope: 'project' | 'module' | 'node'
  targetId?: string
  before: string
  after: string
  userFeedback?: string
  reason: string
}

/** 项目记忆 */
export interface ProjectMemory {
  projectId: string
  projectPath: string
  /** 已识别的业务域 */
  businessDomains: string[]
  /** 架构模式（如"Electron三层架构"） */
  architecturePattern: string
  /** 核心用户流程 */
  coreUserFlows: string[]
  /** 技术约束 */
  techConstraints: string[]
  /** 精炼历史 */
  refinements: RefinementRecord[]
  /** 从精炼中学习的偏好 */
  preferences: {
    granularity: 'coarse' | 'medium' | 'fine'
    namingStyle: 'business' | 'technical' | 'mixed'
    maxModules: number
    avoidPatterns: string[]
  }
  updatedAt: string
}

// ============================================
// Verification types
// ============================================

/** Verification result for a single acceptance criterion */
export interface VerificationResult {
  criterion: string
  passed: boolean
  justification: string
}

/** Verification report for a node */
export interface VerificationReport {
  nodeId: string
  results: VerificationResult[]
  passedCount: number
  totalCount: number
  timestamp: number
}

// ============================================
// IPC 通信类型
// ============================================

export interface IpcApi {
  // 图操作
  'graph:create': (data: { name: string; type: GraphType }) => Promise<Graph>
  'graph:list': () => Promise<Graph[]>
  'graph:get': (id: string) => Promise<{ graph: Graph; nodes: GraphNode[]; edges: GraphEdge[]; bugs: BugNode[] } | null>
  'graph:delete': (id: string) => Promise<boolean>

  // 节点操作
  'node:create': (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GraphNode>
  'node:update': (id: string, data: Partial<GraphNode>) => Promise<GraphNode>
  'node:delete': (id: string) => Promise<boolean>
  'node:batchUpdatePositions': (updates: Array<{ id: string; x: number; y: number }>) => Promise<boolean>

  // 边操作
  'edge:create': (data: Omit<GraphEdge, 'id'>) => Promise<GraphEdge>
  'edge:update': (id: string, data: Partial<GraphEdge>) => Promise<GraphEdge>
  'edge:delete': (id: string) => Promise<boolean>

  // Bug 操作
  'bug:create': (data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<BugNode>
  'bug:update': (id: string, data: Partial<BugNode>) => Promise<BugNode>
  'bug:delete': (id: string) => Promise<boolean>
  'bug:listByNode': (nodeId: string) => Promise<BugNode[]>

  // Agent 操作
  'agent:checkInstalled': (adapterName: string) => Promise<boolean>
  'agent:startSession': (adapterName: string, config: AgentSessionConfig) => Promise<{ sessionId: string; fallback?: boolean }>
  'agent:sendCommand': (sessionId: string, command: AgentCommand) => Promise<void>
  'agent:resolveAndSendCommand': (sessionId: string, command: AgentCommand, contextRefs: ContextRef[], nodeIds: string[]) => Promise<void>
  'agent:terminateSession': (sessionId: string) => Promise<void>
  'agent:listAdapters': () => Promise<{ name: string; version: string; installed: boolean }[]>
  'agent:verify': (params: {
    nodeId: string
    acceptanceCriteria: string[]
    messages: ChatMessage[]
    fileChanges: AgentOutput[]
  }) => Promise<VerificationReport>

  // Chat 会话记录
  'thread:list': (filters?: { nodeId?: string; graphId?: string }) => Promise<AgentThread[]>
  'thread:load': (threadId: string) => Promise<AgentThread | null>
  'thread:create': (data: { adapterName: string; nodeId?: string; graphId?: string }) => Promise<AgentThread>
  'thread:update': (threadId: string, data: { title?: string; status?: string; sessionId?: string }) => Promise<void>
  'thread:delete': (threadId: string) => Promise<void>
  'thread:search': (query: string) => Promise<AgentThread[]>

  'message:list': (threadId: string) => Promise<ChatMessage[]>
  'message:save': (threadId: string, message: ChatMessage) => Promise<void>
  'message:saveBatch': (threadId: string, messages: ChatMessage[]) => Promise<void>

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
  'git:commit': (path: string, message: string) => Promise<void>

  // Dialog 操作
  'dialog:openDirectory': () => Promise<string | null>

  // 项目扫描
  'project:scan': (projectPath: string) => Promise<ProjectScanResult>

  // 从项目初始化图
  'graph:initFromProject': (data: { projectPath: string; projectName: string }) => Promise<{
    onlineGraph: Graph
    devGraph: Graph
    modules: ScanModule[]
  }>

  // 事件监听
  'agent:onOutput': (sessionId: string, output: AgentOutput) => void
  'agent:onStatusChange': (sessionId: string, nodeId: string, status: NodeStatus) => void

  // 配置管理
  'settings:read': () => Promise<BizGraphSettings>
  'settings:write': (settings: BizGraphSettings) => Promise<void>
  'settings:refreshCli': () => Promise<CliToolConfig[]>
  'settings:installCli': (name: string) => Promise<{ success: boolean; message: string }>
  'settings:setApiKey': (provider: string, key: string, baseUrl?: string | null) => Promise<void>

  // MindMap Agent 操作
  'mindmap:generate': (projectPath: string) => Promise<ScanModule[]>
  'mindmap:generateModule': (projectPath: string, parentNodeId: string, parentNodeTitle: string, parentNodeType: NodeType) => Promise<{ childType: NodeType; children: Array<{ title: string; description?: string }> }>
  'mindmap:enrichNode': (projectPath: string, nodeId: string, nodeType: NodeType, nodeTitle: string, relatedFiles?: string[], contextRefs?: ContextRef[]) => Promise<NodeEnrichment>
  'mindmap:refine': (projectPath: string, scope: 'project' | 'module' | 'node', targetId: string, feedback: string) => Promise<ScanModule[] | ScanModule | NodeEnrichment>
  'mindmap:buildDevPrompt': (nodeId: string, nodeTitle: string, nodeType: NodeType, taskType: 'feature' | 'bugfix' | 'refactor', graphId: string, contextRefs?: ContextRef[]) => Promise<string>

  // ScopeGuard 操作
  'scopeGuard:rollbackFile': (sessionId: string, filePath: string) => Promise<boolean>
  'scopeGuard:commitSession': (sessionId: string) => Promise<ValidationResult>
}

// ============================================
// Settings types
// ============================================

export interface CliToolConfig {
  name: string
  npmPackage: string
  command: string
  installed: boolean
  version?: string
  path?: string
}

export interface ApiKeyConfig {
  provider: 'anthropic' | 'openai' | 'deepseek' | 'gemini'
  key: string
  baseUrl?: string
}

export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  enabled: boolean
}

export interface BizGraphSettings {
  version: number
  cliTools: CliToolConfig[]
  apiKeys: ApiKeyConfig[]
  defaultModel?: string
  mcpServers: McpServerConfig[]
}
