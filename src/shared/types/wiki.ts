/**
 * Wiki / Markdown 领域类型定义
 * 用于节点内容页、wikilink 交叉引用、死链检测等功能
 */

/** parseWikiMarkdown 的解析结果 */
export interface WikiMarkdownParseResult {
  /** 原始完整 markdown */
  raw: string
  /** YAML frontmatter 对象（无 frontmatter 时为 {}） */
  frontmatter: Record<string, unknown>
  /** 去除 frontmatter 后的正文 */
  body: string
  /** 从 frontmatter 读取的 title，若 frontmatter 无 title 则取正文第一行 H1 */
  title?: string
}

/** 单个 [[wikilink]] 链接的提取结果 */
export interface WikiLink {
  /** 链接中 `|` 前的目标标题或 ID */
  targetTitle: string
  /** 可选显示文本（`|` 之后） */
  displayText?: string
  /** 链接在文档中的 0-based 字符位置 */
  position: number
}

/** 带解析状态的 wikilink（parseContent 返回） */
export interface WikiLinkResolution {
  targetTitle: string
  displayText?: string
  resolved: boolean
  nodeId?: string
}

/** wiki:parseContent 返回的结构化解析结果 */
export interface ParsedWikiContent {
  frontmatter: Record<string, unknown>
  title?: string
  links: WikiLinkResolution[]
}

/** 悬空链接（断链）记录 */
export interface DanglingLink {
  fromNodeId: string
  fromTitle: string
  targetTitle: string
}

/** 单文件导入失败记录 */
export interface IngestFailure {
  file: string
  error: string
}

/** wiki:ingestFiles 返回的导入结果 */
export interface IngestResult {
  created: { id: string; title: string }[]
  updated: { id: string; title: string }[]
  failed: IngestFailure[]
}

/** 导入模式：规则式 / LLM 提炼式 */
export type IngestMode = 'rule' | 'llm'

/** Graph Lint 单条问题 */
export interface LintIssue {
  kind: 'dangling-link' | 'orphan' | 'community-singleton' | 'community-oversized'
  severity: 'info' | 'warning'
  /** 相关节点（断链时为源节点） */
  nodeId?: string
  message: string
  /** 引导用户如何修复 */
  hint: string
}

/** wiki:lint 返回的报告 */
export interface LintReport {
  issues: LintIssue[]
  stats: { nodeCount: number; edgeCount: number; communityCount: number }
}

/** 单个社区信息 */
export interface CommunityInfo {
  id: string
  memberIds: string[]
  size: number
  internalEdges: number
  externalEdges: number
}

/** wiki:computeCommunities 返回结果 */
export interface ComputeResult {
  communityCount: number
  nodeCount: number
  modularity: number
  communities: CommunityInfo[]
}

export type WritebackKind = 'append-log' | 'new-page'
export type WritebackStatus = 'pending' | 'accepted' | 'discarded'

export interface WritebackItem {
  id: string
  graphId: string
  kind: WritebackKind
  /** 关联节点 id：append-log=追加目标；new-page=源节点（采纳时连边用）。恒非 null。 */
  targetNodeId: string
  title: string
  content: string
  sourceSessionId: string
  confidence: number
  status: WritebackStatus
  createdAt: string
  resolvedAt: string | null
}
