/**
 * BizGraph 核心类型定义
 * 共享于主进程与渲染进程之间
 */

import type { ChildProcess } from 'node:child_process'

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

/** 节点类型 */
export type NodeType =
  | 'module'       // 业务模块
  | 'process'      // 业务流程
  | 'rule'         // 业务规则
  | 'api'          // API 接口
  | 'service'      // 服务
  | 'entity'       // 实体

/** 图类型 */
export type GraphType = 'production' | 'development'

/** 节点自定义样式 */
export interface NodeStyle {
  backgroundColor?: string
  borderColor?: string
  width?: number
  height?: number
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
  /** 父节点 ID（层级结构） */
  parentId?: string
  /** 占位节点的原始节点 ID（用于开发图） */
  placeholderOf?: string
  /** 节点所有者角色 */
  ownerRole?: 'product' | 'developer' | 'tester'
  /** 在画布上的位置 */
  position: { x: number; y: number }
  /** 节点备注（支持 Markdown） */
  notes?: string
  /** 树形模式下是否折叠子树 */
  collapsed?: boolean
  /** 节点自定义样式 */
  style?: NodeStyle
  /** 创建/更新时间 */
  createdAt: string
  updatedAt: string
}

/** 连线类型 */
export type EdgeType = 'default' | 'straight' | 'step' | 'smoothstep' | 'bezier'

/** 连线自定义样式 */
export interface EdgeStyle {
  stroke?: string
  strokeWidth?: number
  strokeDasharray?: string
}

/** 边（连接） */
export interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  graphId: string
  /** 连线类型 */
  edgeType?: EdgeType
  /** 连线样式 */
  style?: EdgeStyle
  /** 流程条件 / 逻辑表达式 */
  condition?: string
  /** 箭头类型 */
  markerEnd?: 'arrow' | 'arrow-closed' | 'none'
}

/** 图定义 */
export interface Graph {
  id: string
  name: string
  type: GraphType
  /** 如果是开发图，对应的真实图 ID */
  sourceGraphId?: string
  /** 如果是开发图，对应的占位节点 ID */
  targetPlaceholderId?: string
  createdAt: string
  updatedAt: string
}

// ============================================
// Bug 相关类型
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
}

/** Agent 会话 */
export interface AgentSession {
  id: string
  process: ChildProcess
  adapterName: string
  config: AgentSessionConfig
  startTime: number
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

  /** 终止会话 */
  terminateSession(sessionId: string): Promise<void>
}

// ============================================
// 范围守卫类型
// ============================================

export interface Sandbox {
  id: string
  workingDir: string
  backupDir: string
  allowedFiles: string[]
  watcher?: unknown
}

export interface ValidationResult {
  compliant: boolean
  /** 越界文件列表 */
  outOfBoundsFiles: string[]
  /** 合规文件列表 */
  validFiles: string[]
  /** 是否需要回滚 */
  shouldRollback: boolean
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
// IPC 通信类型
// ============================================

export interface IpcApi {
  // 图操作
  'graph:create': (data: { name: string; type: GraphType; sourceGraphId?: string }) => Promise<Graph>
  'graph:list': () => Promise<Graph[]>
  'graph:get': (id: string) => Promise<{ graph: Graph; nodes: GraphNode[]; edges: GraphEdge[] } | null>
  'graph:delete': (id: string) => Promise<boolean>

  // 节点操作
  'node:create': (data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<GraphNode>
  'node:update': (id: string, data: Partial<GraphNode>) => Promise<GraphNode>
  'node:delete': (id: string) => Promise<boolean>

  // 边操作
  'edge:create': (data: Omit<GraphEdge, 'id'>) => Promise<GraphEdge>
  'edge:update': (id: string, data: Partial<GraphEdge>) => Promise<GraphEdge>
  'edge:delete': (id: string) => Promise<boolean>

  // Bug 操作
  'bug:create': (data: Omit<BugNode, 'id' | 'createdAt' | 'updatedAt'>) => Promise<BugNode>
  'bug:update': (id: string, data: Partial<BugNode>) => Promise<BugNode>
  'bug:delete': (id: string) => Promise<boolean>
  'bug:listByNode': (nodeId: string) => Promise<BugNode[]>
  'bug:listByGraph': (graphId: string) => Promise<BugNode[]>

  // Agent 操作
  'agent:checkInstalled': (adapterName: string) => Promise<boolean>
  'agent:startSession': (adapterName: string, config: AgentSessionConfig) => Promise<{ sessionId: string }>
  'agent:sendCommand': (sessionId: string, command: AgentCommand) => Promise<void>
  'agent:terminateSession': (sessionId: string) => Promise<void>
  'agent:listAdapters': () => Promise<{ name: string; version: string; installed: boolean }[]>

  // 文件系统
  'fs:readDir': (path: string) => Promise<{ name: string; isDirectory: boolean }[]>
  'fs:readFile': (path: string) => Promise<string>
  'fs:writeFile': (path: string, content: string) => Promise<void>

  // Git 操作
  'git:status': (path: string) => Promise<{ modified: string[]; untracked: string[] }>
  'git:diff': (path: string) => Promise<string>
  'git:commit': (path: string, message: string) => Promise<void>

  // 事件监听
  'agent:onOutput': (sessionId: string, output: AgentOutput) => void
}
