/**
 * BizGraph 常量定义
 *
 * 注意：界面文案不在这里——标签一律走 `@shared/i18n` 的语言感知查表函数
 * （nodeTypeLabel / nodeStatusLabel / edgeTypeOptions …）。这里只留颜色、
 * 枚举和不能翻译的标识。
 */

import type { NodeStatus, NodeType } from './types'

/** 应用信息 */
export const APP_NAME = 'BizGraph'
export const APP_VERSION = '0.1.0'

/** 会话默认标题——存储值固定，界面按语言显示（threadTitle() 负责翻译） */
export const DEFAULT_THREAD_TITLE = 'New Thread'

/** 数据库文件名 */
export const DB_FILENAME = 'bizgraph.db'

/** IPC 通道前缀 */
export const IPC_CHANNEL_PREFIX = 'bizgraph'

/** 节点状态颜色映射（对应 Tailwind 配置） */
export const NODE_STATUS_COLORS: Record<NodeStatus, string> = {
  draft: '#94a3b8',
  confirmed: '#3b82f6',
  developing: '#f59e0b',
  testing: '#8b5cf6',
  review: '#06b6d4',
  published: '#22c55e',
  placeholder: '#64748b',
}

/** 节点类型颜色 */
export const NODE_TYPE_COLORS: Record<NodeType, string> = {
  project: '#6366f1',
  module: '#3b82f6',
  process: '#8b5cf6',
  feature: '#22c55e',
  bug: '#ef4444',
  'wiki-page': '#f59e0b',
}

/** 思维导图中可创建的节点类型——label 走 nodeTypeLabel() */
export const CANVAS_NODE_TYPES = [
  { type: 'project', color: '#6366f1' },
  { type: 'module', color: '#3b82f6' },
  { type: 'process', color: '#8b5cf6' },
  { type: 'feature', color: '#22c55e' },
  { type: 'bug', color: '#ef4444' },
  { type: 'wiki-page', color: '#f59e0b' },
] as const

/** Wiki 页面类型常量 */
export const WIKI_PAGE_TYPE: NodeType = 'wiki-page'

/** 图索引页标题——WikiIndexService 依赖这个英文标识识别特殊页，不能翻译 */
export const GRAPH_INDEX_TITLE = 'Graph Index'

/** 图日志页标题——同上 */
export const GRAPH_LOG_TITLE = 'Graph Log'

/** 支持的 Agent 适配器列表 */
export const SUPPORTED_AGENTS = [
  { name: 'claude-code', displayName: 'Claude Code', npmPackage: '@anthropic-ai/claude-code' },
  { name: 'codex', displayName: 'Codex CLI', npmPackage: '@openai/codex' },
  { name: 'opencode', displayName: 'OpenCode', npmPackage: 'opencode' },
] as const
