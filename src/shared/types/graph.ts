/**
 * 图谱领域类型定义
 * 包含节点、边、图、快照、Bug、项目扫描、MindMap Agent 相关类型
 */

// ============================================
// 上下文引用类型
// ============================================

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
  condition?: string    // 判断条件（如 "库存 > 0"）
  note?: string         // 业务备注（如 "退款时需同步回滚库存"）
  trigger?: 'auto' | 'manual' | 'scheduled'  // 触发方式
  guard?: string        // 守卫表达式（轻量级 DSL，如 "user.role === 'admin'"）
  timeout?: number      // 超时（毫秒）
  retry?: { max: number; delay: number }      // 重试策略
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
// 运行时类型校验常量
// ============================================

export const NODE_STATUS_VALUES = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder'] as const
export const NODE_TYPE_VALUES = ['project', 'module', 'process', 'feature', 'bug'] as const
export const GRAPH_TYPE_VALUES = ['online', 'dev'] as const
export const EDGE_TYPE_VALUES = ['default', 'success', 'failure', 'condition', 'business-flow'] as const
export const BUG_SEVERITY_VALUES = ['low', 'medium', 'high', 'critical'] as const
export const BUG_STATUS_VALUES = ['open', 'fixed', 'verified'] as const

// ============================================
// 节点类型注册表（支持动态扩展节点类型）
// ============================================

/** 节点类型配置（用于注册新节点类型） */
export interface NodeTypeConfig {
  type: string
  label: string
  /** 节点图标标识（用于 UI 渲染） */
  icon?: string
  /** 默认状态 */
  defaultStatus?: NodeStatus
  /** 允许作为父节点的类型 */
  allowedParentTypes?: string[]
  /** 允许作为子节点的类型 */
  allowedChildTypes?: string[]
  /** 节点描述模板 */
  descriptionTemplate?: string
}

/**
 * 节点类型注册表
 * 支持动态注册新节点类型，无需修改硬编码常量。
 * 默认注册项目内置类型，业务方可通过 register() 扩展。
 */
class NodeTypeRegistry {
  private types = new Map<string, NodeTypeConfig>()

  constructor() {
    // 注册内置类型
    const builtin: NodeTypeConfig[] = [
      { type: 'project', label: '项目根节点', defaultStatus: 'confirmed', allowedChildTypes: ['module'] },
      { type: 'module', label: '业务模块', defaultStatus: 'draft', allowedParentTypes: ['project'], allowedChildTypes: ['process'] },
      { type: 'process', label: '业务流程', defaultStatus: 'draft', allowedParentTypes: ['module'], allowedChildTypes: ['feature', 'bug'] },
      { type: 'feature', label: '功能点', defaultStatus: 'placeholder', allowedParentTypes: ['process'] },
      { type: 'bug', label: 'BUG点', defaultStatus: 'draft', allowedParentTypes: ['process'] },
    ]
    for (const config of builtin) {
      this.types.set(config.type, config)
    }
  }

  /** 注册新节点类型（覆盖同名旧类型） */
  register(config: NodeTypeConfig): void {
    this.types.set(config.type, config)
  }

  /** 获取节点类型配置 */
  get(type: string): NodeTypeConfig | undefined {
    return this.types.get(type)
  }

  /** 获取所有已注册的类型名称 */
  listTypes(): string[] {
    return Array.from(this.types.keys())
  }

  /** 获取所有已注册配置 */
  listConfigs(): NodeTypeConfig[] {
    return Array.from(this.types.values())
  }

  /** 检查类型是否已注册 */
  has(type: string): boolean {
    return this.types.has(type)
  }

  /** 校验节点父子关系是否合法 */
  validateParentChild(parentType: string, childType: string): boolean {
    const parent = this.types.get(parentType)
    const child = this.types.get(childType)
    if (!parent || !child) return false
    if (parent.allowedChildTypes && !parent.allowedChildTypes.includes(childType)) return false
    if (child.allowedParentTypes && !child.allowedParentTypes.includes(parentType)) return false
    return true
  }
}

/** 全局单例节点类型注册表 */
export const nodeTypeRegistry = new NodeTypeRegistry()
