/**
 * Agent 领域类型定义
 * 包含适配器、会话、范围守卫、日志、验证、代码智能相关类型
 */

import type { ContextRef, BugSeverity } from './graph'

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
  /** 智能代码上下文（由 SmartContextResolver 生成，不持久化） */
  codeContext?: string
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
  adapterPreferences?: AdapterPreferences
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
