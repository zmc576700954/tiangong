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

/** Lint 问题严重度 */
export type LintSeverity = 'error' | 'warning' | 'info'

/** Lint 问题 kind（用于按类别分组渲染） */
export type LintIssueKind =
  | 'dangling-link'
  | 'orphan'
  | 'community-singleton'
  | 'community-oversized'
  | 'missing-frontmatter'
  | 'inconsistent-case'

/** Lint 问题 code（用于修复路由与唯一标识） */
export type LintIssueCode =
  | 'dangling-link'
  | 'orphan'
  | 'community-singleton'
  | 'community-oversized'
  | 'missing-frontmatter'
  | 'inconsistent-case'

/** 修复动作描述（fix payload 形状按 kind 区分） */
export interface LintFixAction {
  /** 修复动作标识（对应 main 侧 dispatch key） */
  kind: 'create-stub-page' | 'add-frontmatter' | 'normalize-case'
  /** 修复所需参数 */
  payload: Record<string, unknown>
}

/** 问题在文件/节点上的位置（用于跳转） */
export interface LintIssueLocation {
  /** 节点 ID（断链 / orphan 等图内问题时为源节点 ID） */
  file: string
  /** 可选行号（仅当 issue 锚定到具体行时填写） */
  line?: number
  /** 可选列号 */
  column?: number
}

/** Graph Lint 单条问题 */
export interface LintIssue {
  /** 问题类别（用于 UI 分组） */
  kind: LintIssueKind
  /** 严重度（用于排序与 UI 染色） */
  severity: LintSeverity
  /** 问题唯一 code（用于修复路由 / 测试 / 国际化） */
  code: LintIssueCode
  /** 相关节点（断链时为源节点） */
  nodeId?: string
  /** 问题描述（中文，用户可读） */
  message: string
  /** 引导用户如何修复 */
  hint: string
  /** 锚点位置：UI 可用于"跳转到节点"或"跳转到行" */
  location?: LintIssueLocation
  /** 是否可一键修复 */
  fixable: boolean
  /** 修复动作（fixable=true 时填写）；UI 调 wiki:applyFix(code, payload) */
  fix?: LintFixAction
}

/** wiki:lint 返回的报告 */
export interface LintReport {
  issues: LintIssue[]
  stats: { nodeCount: number; edgeCount: number; communityCount: number }
}

/** wiki:applyFix 的返回结果 */
export interface LintFixResult {
  /** 是否成功 */
  ok: boolean
  /** 受影响节点 ID（创建 stub 页时为新节点 ID；其余为被改节点 ID） */
  nodeId?: string
  /** 错误信息（失败时） */
  error?: string
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
  /** 仅 append-log：详情折叠块正文（不含 `<details>` 标签）。前端用 `<details>` 包裹渲染。 */
  details?: string
  /** 仅 append-log：会话叙事导言（不含 ## 标题、不含详情折叠）。 */
  narrative?: string
  /** 仅 new-page：从这些 source node 聚类出来的概念来源。 */
  sourceNodeIds?: string[]
  /** 仅 new-page：源节点标题（采纳时连边用的源节点的标题快照）。 */
  targetNodeTitle?: string
  sourceSessionId: string
  confidence: number
  status: WritebackStatus
  createdAt: string
  resolvedAt: string | null
}
