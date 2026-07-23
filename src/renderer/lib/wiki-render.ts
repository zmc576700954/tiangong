/**
 * Wiki 渲染纯函数：把 markdown 文本中的 [[wikilink]] 切分为渲染片段。
 * 解析状态（resolved / nodeId）来自后端 wiki:parseContent，前端不做标题匹配。
 */

export interface WikiLinkResolution {
  targetTitle: string
  displayText?: string
  resolved: boolean
  nodeId?: string
}

export type WikiRenderSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; raw: string; targetTitle: string; displayText?: string; resolved: boolean; nodeId?: string }

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g

export function parseLinkTarget(inner: string): { targetTitle: string; displayText?: string } {
  const pipeIdx = inner.indexOf('|')
  if (pipeIdx === -1) return { targetTitle: inner.trim() }
  return {
    targetTitle: inner.slice(0, pipeIdx).trim(),
    displayText: inner.slice(pipeIdx + 1).trim() || undefined,
  }
}

export function splitWikiLinks(text: string, links: WikiLinkResolution[]): WikiRenderSegment[] {
  const byKey = new Map(links.map((l) => [l.targetTitle.trim().toLowerCase(), l]))
  const segments: WikiRenderSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  WIKILINK_RE.lastIndex = 0
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) })
    }
    const { targetTitle, displayText } = parseLinkTarget(match[1])
    const resolution = byKey.get(targetTitle.toLowerCase())
    segments.push({
      kind: 'link',
      raw: match[0],
      targetTitle,
      displayText,
      resolved: resolution?.resolved ?? false,
      nodeId: resolution?.nodeId,
    })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) })
  }
  if (segments.length === 0) segments.push({ kind: 'text', text })
  return segments
}

export function formatMetaValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}
