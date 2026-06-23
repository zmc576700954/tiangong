/**
 * Agent 领域类型定义
 * 包含适配器、会话、范围守卫、日志、验证、代码智能相关类型
 */

import type { ContextRef, BugSeverity } from './graph'
import type { AgentTypeDefinition } from './subagent'

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
  /** 前序会话的上下文摘要（用于不支持原生 resume 的适配器实现伪连续性） */
  contextSummary?: string
  /** Claude Code 会话续接 ID，非空时 spawn 命令加 --resume */
  resumeSessionId?: string
  /** 关联的节点 ID（用于状态同步） */
  nodeId?: string
  /** 命令类型（用于 placeholder→developing 自动触发等状态联动） */
  commandType?: AgentCommandType
  /** 会话超时时间（毫秒），降级适配器自动缩短 */
  timeoutMs?: number
  /** 父 session（子代理 invocation 时回链）；Phase 1 仅占位，Phase 4 起用 */
  parentSessionId?: string
  /** SubagentInvocation.id — Phase 1 仅占位，Phase 4 起用 */
  swarmTaskId?: string
  /** Phase 3: thread to bind for waterline tracking & history persistence. */
  threadId?: string
  /** Phase 4: subagent tool restriction (consumed by adapters in Claude Code / MCP). */
  subagentAllowedTools?: string[] | '*'
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
  type: 'stdout' | 'stderr' | 'file_change' | 'error' | 'complete' | 'system'
  data: string
  timestamp: number
  /** 如果是 file_change，记录变更的文件路径 */
  filePath?: string
  /** 如果是 file_change，记录变更类型 */
  changeType?: 'add' | 'modify' | 'delete'
  /** 错误分类码 */
  errorCode?: string
  /** 自动模式分类 (file_operation / error_report / progress_update / code_change) */
  pattern?: string
  /** Phase 2: subagent output routing tag. Set by SubagentManager (Phase 4). */
  invocationId?: string
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
  | 'queued'      // 已入队，等待处理
  | 'sending'     // 正在发送到 agent
  | 'streaming'   // agent 正在输出
  | 'success'     // agent 正常完成
  | 'error'       // 出错
  | 'aborted'     // 用户主动终止
  | 'permanently_failed' // 重试次数耗尽，需手动干预

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
  fallbackInfo?: { originalAdapter: string; fallbackReason: string }
  /** 父 thread 引用（reserved；Phase 1 仅占位，subagent flow 不使用） */
  parentThreadId?: string
  /** 当前 thread 已用 token（来自 ContextWaterline；Phase 2 起填值） */
  contextTokensUsed?: number
  /** 当前 thread 的 token 窗口上限（来自 ADAPTER_REGISTRY；Phase 2 起填值） */
  contextWindowMax?: number
  /** 最近一次压缩的时间戳；Phase 3 起填值 */
  lastCompactedAt?: number
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
  /** 智能代码上下文（由 SmartContextResolver 生成，不持久化） */
  codeContext?: string
  /** 项目记忆上下文（从 .bizgraph/memory.json 加载，不持久化） */
  memoryContext?: string
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

  /** 设置会话的智能代码上下文（供 AgentManager 注入代码分析结果） */
  setCodeContext(sessionId: string, codeContext: string): void

  /** 设置会话的项目记忆上下文（供 AgentManager 注入项目记忆） */
  setMemoryContext(sessionId: string, memoryContext: string): void

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
  /** Token 经济学追踪（新增，借鉴 claude-mem） */
  tokenEconomics?: TokenEconomics
}

// ============================================
// Agent 会话记忆（借鉴 claude-mem 设计）
// ============================================

/** 记忆类型 —— 借鉴 claude-mem 的 observation_types 但适配 BizGraph 场景 */
export type MemoryKind =
  | 'investigation'    // 调查记录
  | 'fix'              // 修复记录
  | 'review_finding'   // 审查发现
  | 'decision'         // 架构/修复决策
  | 'pattern'          // 发现的代码模式
  | 'lesson'           // 学到的经验教训
  | 'waterline'        // 水线标记（跨会话知识基线）

/** 单条记忆 —— 对应 claude-mem 的 observation */
export interface MemoryItem {
  id: number
  session_id: string           // agent_sessions.id
  kind: MemoryKind
  project_id: string           // graphs.id
  node_id: string | null       // 关联的思维导图节点
  title: string                // 一句话摘要（L1 层）
  narrative: string            // 详细叙述
  facts: string[]              // 结构化事实列表
  concepts: string[]           // 概念标签（problem-solution, how-it-works 等）
  files_read: string[]         // 读取的文件
  files_modified: string[]     // 修改的文件
  adapter_name: string         // claude-code / codex / opencode
  token_cost: number           // 消耗的 token 数
  confidence: number           // 置信度 0-1
  created_at: string           // ISO 时间戳
  version?: number             // 记忆版本号（用于乐观锁和版本链）
  parent_version?: number | null  // 父版本号（版本链追溯）
  embedding?: number[] | null  // 向量嵌入（语义检索用）
}

/** 上下文层级 —— 借鉴 claude-mem 的渐进式披露 */
export interface ContextLayer {
  /** 1 = 最紧凑, 4 = 最完整 */
  level: 1 | 2 | 3 | 4
  label: string
  content: string
  estimatedTokens: number
}

/** 分层上下文包 */
export interface LayeredContext {
  layers: ContextLayer[]
}

/** Token 经济学指标 —— 借鉴 claude-mem 的 discovery_tokens vs read_tokens */
export interface TokenEconomics {
  /** 原始工作消耗的 token（LLM 实际调用） */
  discoveryTokens: number
  /** 压缩后上下文消耗的 token（注入到下游的） */
  readTokens: number
  /** 压缩节省的 token */
  savings: number
  /** 节省百分比 */
  savingsPct: number
}

/** Agent 工作模式 —— 借鉴 claude-mem 的 Mode 系统 */
export type AgentMode =
  | 'general'
  | 'security'       // 安全审计模式
  | 'performance'    // 性能优化模式
  | 'refactor'       // 重构模式

/** Agent 模式配置 —— 影响 SubAgent 的关注点和行为 */
export interface AgentModeConfig {
  name: AgentMode
  description: string
  /** 影响 Investigator 的关注点 */
  investigationFocus: string[]
  /** 影响 Reviewer 的扫描规则 */
  reviewPriorities: string[]
  /** 影响 Fixer 的安全级别 */
  fixSafety: 'strict' | 'standard' | 'aggressive'
  /** 追加到 Agent system prompt 的后缀 */
  systemPromptSuffix: string
  /** 该模式下值得记录的记忆类型 */
  memoryTypes: MemoryKind[]
}

/** 默认模式配置 —— 各模式的关注点和行为预设（Phase 2 ModeManager 将读取这些配置） */
export const DEFAULT_MODE_CONFIGS: Record<AgentMode, AgentModeConfig> = {
  general: {
    name: 'general',
    description: '通用开发模式：均衡关注功能实现、代码质量和可维护性',
    investigationFocus: ['代码结构', '依赖关系', '现有测试', '最近变更'],
    reviewPriorities: ['功能正确性', '代码风格', '错误处理', '测试覆盖'],
    fixSafety: 'standard',
    systemPromptSuffix: 'Focus on balanced code quality: correctness, readability, and maintainability.',
    memoryTypes: ['fix', 'investigation', 'pattern', 'lesson'],
  },
  security: {
    name: 'security',
    description: '安全审计模式：重点扫描注入、认证、授权、敏感数据泄露等安全问题',
    investigationFocus: ['输入验证', '认证流程', '授权逻辑', '敏感数据处理', '依赖漏洞'],
    reviewPriorities: ['注入攻击', 'XSS/CSRF', '认证绕过', '敏感数据泄露', '不安全配置'],
    fixSafety: 'strict',
    systemPromptSuffix: 'CRITICAL: Focus on security vulnerabilities. Do NOT modify business logic unless it has a security impact. All changes must be minimal and reversible.',
    memoryTypes: ['fix', 'investigation', 'lesson'],
  },
  performance: {
    name: 'performance',
    description: '性能优化模式：关注瓶颈识别、算法优化、缓存策略、资源使用',
    investigationFocus: ['热点路径', '内存分配', 'IO 操作', '数据库查询', '缓存命中率'],
    reviewPriorities: ['算法复杂度', '内存泄漏', '不必要的 IO', 'N+1 查询', '大对象分配'],
    fixSafety: 'aggressive',
    systemPromptSuffix: 'Focus on measurable performance improvements. Prefer algorithmic optimizations over micro-optimizations. Add benchmarks when possible.',
    memoryTypes: ['investigation', 'pattern', 'fix'],
  },
  refactor: {
    name: 'refactor',
    description: '重构模式：关注代码结构改进、消除技术债务、提升可测试性',
    investigationFocus: ['代码异味', '循环依赖', '过长函数', '重复代码', '测试缺口'],
    reviewPriorities: ['单一职责', '接口隔离', '依赖方向', '可测试性', '向后兼容'],
    fixSafety: 'standard',
    systemPromptSuffix: 'Focus on structural improvements without changing external behavior. Keep changes small and incremental. Ensure existing tests still pass.',
    memoryTypes: ['pattern', 'decision', 'fix', 'lesson'],
  },
}

/** 输出健康状态 —— 借鉴 claude-mem 的输出分类器 */
export type OutputHealth =
  | 'valid'       // 正常输出，可解析
  | 'truncated'   // 输出被截断
  | 'poisoned'    // 上下文耗尽信号
  | 'empty';      // 空白/仅空白

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
  /** Model used for context compaction summaries; falls back to defaultModel if unset */
  compactModel?: string
  mcpServers: McpServerConfig[]
  adapterPreferences?: AdapterPreferences
  /** Phase 5: user-defined subagent types persisted in settings.json. */
  customAgentTypes?: AgentTypeDefinition[]
  /** Phase 5: context waterline config persisted in settings.json. */
  contextWaterline?: {
    autoCompactEnabled?: boolean
    autoCompactThreshold?: number
    minCompactInterval?: number
  }
}

/** 适配器自动回退链中的单次尝试记录 */
export interface AdapterFallbackAttempt {
  adapter: string
  reason: string
  success: boolean
}

/** 适配器偏好配置 */
export interface AdapterPreferences {
  /** 默认适配器（未指定时使用） */
  defaultAdapter: string
  /** 回退顺序（默认适配器失败后按序尝试） */
  fallbackOrder: string[]
  /** 强制使用指定适配器，不进行健康度重排序 */
  forceAdapter?: boolean
}

/** 适配器能力枚举 */
export const AdapterCapability = {
  Resume: 'resume',
  Streaming: 'streaming',
  FileOps: 'fileOps',
  MultiTurn: 'multiTurn',
  ScopeGuard: 'scopeGuard',
  Tools: 'tools',
  // Phase 1 additions — context compaction & subagent dispatch
  NativeCompact: 'native-compact',
  LlmCompact: 'llm-compact',
  SummaryRewrite: 'summary-rewrite',
  SwarmCoordinator: 'swarm-coord',
} as const
export type AdapterCapability = typeof AdapterCapability[keyof typeof AdapterCapability]

/** 适配器安装方式 */
export interface InstallMethod {
  type: 'npm' | 'npx' | 'brew' | 'curl' | 'winget' | 'scoop' | 'choco' | 'pip' | 'api-key' | 'manual'
  command: string
  label: string
  platform?: 'win32' | 'darwin' | 'linux'
}

/** 适配器市场条目（前端展示用） */
export interface AdapterMarketplaceItem {
  name: string
  displayName: string
  description: string
  type: 'cli' | 'sdk' | 'api'
  installed: boolean
  version: string
  installMethods: InstallMethod[]
  homepage: string
  /** 当前平台推荐安装方式的索引 */
  recommendedInstallIndex: number
}

// ============================================
// 代码智能（Code Intelligence）类型
// ============================================

/** 代码符号类型 */
export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'import'
  | 'export'
  | 'namespace'
  | 'decorator'

/** 单个代码符号的定义信息 */
export interface SymbolInfo {
  id: string // 全局唯一标识
  name: string // 符号名称（如 UserService）
  kind: SymbolKind
  filePath: string // 绝对路径
  line: number // 定义起始行（1-based）
  column: number // 定义起始列
  endLine?: number // 定义结束行
  endColumn?: number // 定义结束列
  signature?: string // 函数/方法签名文本
  jsDoc?: string // JSDoc/注释文本
  parentId?: string // 父符号 ID（如类中的方法）
  isExported: boolean
  sourceCode?: string // 符号的完整源码
}

/** Import/Export 关系边 */
export interface ImportEdge {
  fromFile: string // 导入方文件绝对路径
  toFile: string // 导出方文件绝对路径
  importedNames: string[] // 导入的符号名列表
  isDefaultImport: boolean
  line: number
}

/** 符号引用关系 */
export interface SymbolReference {
  symbolId: string
  filePath: string
  line: number
  column: number
  isDefinition: boolean // true=定义处, false=引用处
}

/** 符号索引查询结果 */
export interface SymbolQueryResult {
  symbol: SymbolInfo
  score: number // 匹配得分
  matchedBy: 'exact' | 'fuzzy' | 'semantic' | 'path'
}

/** 代码智能执行计划 */
export interface CodeIntelExecutionPlan {
  intent: string
  steps: Array<{
    id: string
    action: 'read' | 'modify' | 'create' | 'test' | 'verify'
    target: string
    description: string
    dependencies: string[]
  }>
  estimatedComplexity: 'simple' | 'moderate' | 'complex'
  requiresNewFiles: boolean
  affectedSymbols: string[]
}

// ============================================
// Context compaction (Phase 1 of context-compaction-and-subagent-dispatch)
// ============================================

/** Compaction strategy chosen by the adapter for one compact call. */
export type CompactStrategy = 'native' | 'llm' | 'summary'

/** What triggered a compaction. */
export type CompactTrigger = 'manual' | 'auto-threshold' | 'auto-token-limit'

/** Result of a compact call — returned by AgentManager and persisted to compact_history. */
export interface CompactResult {
  sessionId: string
  strategy: CompactStrategy
  trigger: CompactTrigger
  tokensBefore: number
  tokensAfter: number
  summary?: string
  startedAt: number
  durationMs: number
  /** True when the actual token reduction is deferred (e.g. SDK auto-compact on next turn).
   *  When deferred, history/waterline persistence is skipped until the real reduction occurs. */
  deferred?: boolean
}

/** Persisted compact_history row (renderer-facing shape). */
export interface CompactHistoryEntry {
  id: string
  threadId: string | null
  sessionId: string | null
  strategy: CompactStrategy
  trigger: CompactTrigger
  tokensBefore: number
  tokensAfter: number
  summary: string | null
  startedAt: number
  durationMs: number
}

/** Runtime waterline state for one thread. Pushed via waterline:change IPC. */
export interface ContextState {
  threadId: string
  tokensUsed: number
  tokensMax: number
  ratio: number                // 0.0–1.0, derived
  lastCompactedAt: number | null
  updatedAt: number
}
