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

/** 节点类型标签 */
export const NODE_TYPE_LABELS: Record<string, string> = {
  module: '业务模块',
  process: '业务流程',
  rule: '业务规则',
  api: 'API 接口',
  service: '服务',
  entity: '实体',
}

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
  production: '真实图',
  development: '开发图',
}

/** 连线类型标签 */
export const EDGE_TYPE_LABELS: Record<string, string> = {
  default: '默认',
  straight: '直线',
  step: '直角折线',
  smoothstep: '圆角折线',
  bezier: '贝塞尔',
}

/** 箭头类型标签 */
export const MARKER_END_LABELS: Record<string, string> = {
  arrow: '空心箭头',
  'arrow-closed': '实心箭头',
  none: '无箭头',
}

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
