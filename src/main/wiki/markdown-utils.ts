/**
 * Wiki 风格 Markdown 解析工具
 *
 * 纯函数库，负责：
 * - 解析带 YAML frontmatter 的 markdown
 * - 提取 [[wikilink]] 链接
 * - 序列化回标准 markdown
 * - 标题归一化
 *
 * 不依赖 DB / IPC / renderer，仅做文本处理。
 */

import yaml from 'js-yaml'
import { BizGraphError, ErrorCode } from '../errors'
import type { WikiLink, WikiMarkdownParseResult } from '@shared/types/wiki'

export type { WikiLink, WikiMarkdownParseResult } from '@shared/types/wiki'

/** 标准 YAML frontmatter：`---\n...\n---`（兼容空 frontmatter `---\n---`） */
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)|^---\r?\n---\r?(?:\n|$)/

/** Wikilink 匹配：`[[Target]]` 或 `[[Target|Display]]` */
const WIKILINK_REGEX = /\[\[([^[\]|]+?)(?:\|([^[\]|]+?))?\]\]/g

/**
 * 解析带 YAML frontmatter 的 markdown。
 *
 * @throws {BizGraphError} frontmatter YAML 解析失败时抛出 WIKI_PARSE_ERROR
 */
export function parseWikiMarkdown(markdown: string): WikiMarkdownParseResult {
  const raw = markdown
  const match = FRONTMATTER_REGEX.exec(raw)

  let frontmatter: Record<string, unknown> = {}
  let body = raw

  if (match) {
    const yamlContent = match[1] ?? ''
    try {
      const parsed = yaml.load(yamlContent)
      frontmatter = (parsed as Record<string, unknown> | null | undefined) ?? {}
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new BizGraphError(`Failed to parse YAML frontmatter: ${message}`, ErrorCode.WIKI_PARSE_ERROR)
    }
    body = raw.slice(match[0].length)
  }

  // 清理 body 首尾空行（支持 \n 与 \r\n）
  body = body.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '')

  // 标题优先读取 frontmatter.title，否则取正文第一行 H1
  let title: string | undefined
  const frontmatterTitle = frontmatter.title
  if (typeof frontmatterTitle === 'string' && frontmatterTitle.trim().length > 0) {
    title = frontmatterTitle.trim()
  } else {
    const h1Match = /^#\s+(.+)$/m.exec(body)
    if (h1Match) {
      title = h1Match[1].trim()
    }
  }

  return {
    raw,
    frontmatter,
    body,
    title,
  }
}

/**
 * 从 markdown 中提取 `[[...]]` 形式的 wikilink。
 *
 * 跳过：
 * - 行内代码 `` `...` ``
 * - 围栏代码块 ``` ... ``` / ~~~ ... ~~~
 */
export function extractWikiLinks(markdown: string): WikiLink[] {
  const inCode = buildCodeMask(markdown)
  const links: WikiLink[] = []

  let match: RegExpExecArray | null
  while ((match = WIKILINK_REGEX.exec(markdown)) !== null) {
    const start = match.index
    const end = start + match[0].length - 1

    // 仅当 link 首尾括号均在代码区域外时才视为有效 wikilink
    if (!inCode[start] && !inCode[end]) {
      const link: WikiLink = {
        targetTitle: match[1].trim(),
        position: start,
      }
      if (match[2]) {
        link.displayText = match[2].trim()
      }
      links.push(link)
    }
  }

  return links
}

/**
 * 将 frontmatter 与正文组合为标准 markdown。
 *
 * - frontmatter 为空对象时直接返回 body
 * - YAML 使用 2 空格缩进
 */
export function stringifyWikiMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return body
  }

  const yamlStr = yaml.dump(frontmatter, { indent: 2, lineWidth: -1 }).trimEnd()
  const trimmedBody = body.replace(/^\n+/, '')

  if (trimmedBody.length === 0) {
    return `---\n${yamlStr}\n---`
  }

  return `---\n${yamlStr}\n---\n\n${trimmedBody}`
}

/**
 * 归一化 wikilink 标题：
 * - 去除首尾空白
 * - 全角空格替换为半角空格
 * - 多个连续空白合并为一个空格
 */
export function normalizeWikiTitle(title: string): string {
  return title
    .trim()
    .replace(/\u3000/g, ' ')   // 全角空格 → 半角空格
    .replace(/\s+/g, ' ')      // 连续空白合并
}

// ============================================================
// 内部辅助：计算代码区域掩码
// ============================================================

/** 返回与文本等长的布尔数组，true 表示该字符位于代码（块/行内）区域内 */
function buildCodeMask(text: string): boolean[] {
  const mask = new Array(text.length).fill(false)
  const len = text.length

  let inBlock = false
  let blockFenceLen = 0
  let blockFenceChar = ''
  let i = 0

  while (i < len) {
    if (isLineStart(text, i)) {
      const { char, count } = countFence(text, i)
      if (count >= 3 && (char === '`' || char === '~')) {
        if (!inBlock) {
          inBlock = true
          blockFenceLen = count
          blockFenceChar = char
          markRange(mask, i, i + count)
          i += count
          continue
        }
        if (char === blockFenceChar && count >= blockFenceLen) {
          markRange(mask, i, i + count)
          inBlock = false
          i += count
          continue
        }
      }
    }

    if (inBlock) {
      mask[i] = true
      i++
      continue
    }

    if (text[i] === '`') {
      const { count } = countFence(text, i)
      const closeIdx = findInlineCodeClose(text, i + count, count)
      if (closeIdx !== -1) {
        markRange(mask, i, closeIdx + count)
        i = closeIdx + count
        continue
      }
    }

    i++
  }

  return mask
}

function isLineStart(text: string, idx: number): boolean {
  return idx === 0 || text[idx - 1] === '\n' || text[idx - 1] === '\r'
}

function countFence(text: string, idx: number): { char: string; count: number } {
  const char = text[idx]
  let count = 0
  while (idx + count < text.length && text[idx + count] === char) {
    count++
  }
  return { char, count }
}

function findInlineCodeClose(text: string, startIdx: number, fenceLen: number): number {
  let i = startIdx
  while (i < text.length) {
    const { char, count } = countFence(text, i)
    if (char === '`' && count === fenceLen) {
      return i
    }
    i += count > 0 ? count : 1
  }
  return -1
}

function markRange(mask: boolean[], start: number, end: number): void {
  for (let k = start; k < end && k < mask.length; k++) {
    mask[k] = true
  }
}
