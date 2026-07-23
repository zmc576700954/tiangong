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
