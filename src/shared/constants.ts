/**
 * BizGraph 常量定义
 */

/** 应用信息 */
export const APP_NAME = 'BizGraph'
export const APP_VERSION = '0.1.0'

/** 数据库文件名 */
export const DB_FILENAME = 'bizgraph.db'

/** IPC 通道前缀 */
export const IPC_CHANNEL_PREFIX = 'bizgraph'

/** 节点状态颜色映射（对应 Tailwind 配置） */
export const NODE_STATUS_COLORS: Record<string, string> = {
  draft: '#94a3b8',
  confirmed: '#3b82f6',
  developing: '#f59e0b',
  testing: '#8b5cf6',
  review: '#06b6d4',
  published: '#22c55e',
  placeholder: '#64748b',
}

/** 节点状态标签 */
export const NODE_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  confirmed: '已确认',
  developing: '开发中',
  testing: '待测试',
  review: '待验收',
  published: '已发布',
  placeholder: '占位',
}

/** 思维导图中显示的节点类型标签 */
export const NODE_TYPE_LABELS: Record<string, string> = {
  module: '业务模块',
  process: '业务流程',
  feature: '功能点',
  bug: 'BUG点',
}

/** 节点类型颜色 */
export const NODE_TYPE_COLORS: Record<string, string> = {
  module: '#3b82f6',
  process: '#8b5cf6',
  feature: '#22c55e',
  bug: '#ef4444',
}

/** 思维导图中可创建的节点类型 */
export const CANVAS_NODE_TYPES = [
  { type: 'module', label: '业务模块', color: '#3b82f6' },
  { type: 'process', label: '业务流程', color: '#8b5cf6' },
  { type: 'feature', label: '功能点', color: '#22c55e' },
  { type: 'bug', label: 'BUG点', color: '#ef4444' },
] as const

/** Bug 严重级别标签 */
export const BUG_SEVERITY_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
}

/** Bug 状态标签 */
export const BUG_STATUS_LABELS: Record<string, string> = {
  open: '未修复',
  fixed: '已修复',
  verified: '已验证',
}

/** 图类型标签 */
export const GRAPH_TYPE_LABELS: Record<string, string> = {
  online: '已上线场景',
  dev: '开发场景',
}

/** 边类型选项（用于画布和属性面板统一） */
export const EDGE_TYPE_OPTIONS: { type: 'default' | 'success' | 'failure' | 'condition'; label: string; color: string; description: string }[] = [
  { type: 'default', label: '默认流程', color: '#94a3b8', description: '标准流程连接' },
  { type: 'success', label: '成功分支', color: '#22c55e', description: '成功后的流程分支' },
  { type: 'failure', label: '失败分支', color: '#ef4444', description: '失败后的异常分支' },
  { type: 'condition', label: '条件分支', color: '#f59e0b', description: '条件判断分支' },
]

/** 支持的 Agent 适配器列表 */

/** 支持的 Agent 适配器列表 */
export const SUPPORTED_AGENTS = [
  { name: 'claude-code', displayName: 'Claude Code', npmPackage: '@anthropic-ai/claude-code' },
  { name: 'codex', displayName: 'Codex CLI', npmPackage: '@openai/codex' },
  { name: 'opencode', displayName: 'OpenCode', npmPackage: 'opencode' },
] as const

/** Agent 命令类型标签 */
export const AGENT_COMMAND_LABELS: Record<string, string> = {
  implement: '实现',
  fix_bug: '修复 Bug',
  refactor: '重构',
  add_test: '添加测试',
}
