import type { MemoryItem } from '@shared/types'
import type { WritebackItem } from '@shared/types/wiki'
import { normalizeWikiTitle } from '../wiki/markdown-utils'

export interface WritebackRepoLike {
  create(data: Omit<WritebackItem, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): WritebackItem
  findBySession(sourceSessionId: string): WritebackItem[]
}

/** 提供「现有节点标题」查询，用于 new-page concept 去重 */
export interface NodeTitleSource {
  findExistingTitles(graphId: string): string[]
}

export interface GenerateInput {
  graphId: string
  nodeId: string
  nodeTitle: string
  sessionId: string
  memories: Array<Omit<MemoryItem, 'id'>>
}

const TOP_N = 5
const MIN_CLUSTER = 2

/** 转义 markdown 特殊字符，防止 agent 产出内容注入虚假 wikilink/格式 */
function escMd(s: string): string {
  return s.replace(/([\\`*_[\]{}()#+.!|<>])/g, '\\$1')
}

/** 把换行符替换为空格，避免注入 frontmatter/标题/链接 */
function stripNewlines(s: string): string {
  return s.replace(/\n/g, ' ')
}

export class WritebackService {
  constructor(
    private readonly repo: WritebackRepoLike,
    private readonly titles: NodeTitleSource,
  ) {}

  generate(input: GenerateInput, now: Date = new Date()): WritebackItem[] {
    if (input.memories.length === 0) return []
    if (this.repo.findBySession(input.sessionId).length > 0) return []

    const top = [...input.memories]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, TOP_N)
    const confidence = top.reduce((s, m) => s + (m.confidence ?? 0), 0) / top.length

    const safeNodeTitle = stripNewlines(input.nodeTitle)
    const created: WritebackItem[] = []
    created.push(this.repo.create({
      graphId: input.graphId,
      kind: 'append-log',
      targetNodeId: input.nodeId,
      title: `会话日志 · ${now.toISOString().slice(0, 10)}`,
      content: this.buildAppendLog(top, confidence, now),
      sourceSessionId: input.sessionId,
      confidence,
    }))

    for (const cluster of this.clusterNovelConcepts(top, input.graphId)) {
      const concept = stripNewlines(cluster.concept)
      created.push(this.repo.create({
        graphId: input.graphId,
        kind: 'new-page',
        targetNodeId: input.nodeId, // 源节点 id，采纳时连边用
        title: concept,
        content: this.buildNewPage(concept, cluster.memories, safeNodeTitle),
        sourceSessionId: input.sessionId,
        confidence,
      }))
    }
    return created
  }

  private buildAppendLog(
    top: Array<Omit<MemoryItem, 'id'>>,
    confidence: number,
    now: Date,
  ): string {
    const adapter = top[0]?.adapter_name ?? 'agent'
    const bullets = top.map((m) => `- ${escMd(m.title)}`).join('\n')
    const detail = top
      .map((m) => {
        const facts = m.facts.length
          ? '\n\n' + m.facts.map((f) => `- ${escMd(f)}`).join('\n')
          : ''
        return `### ${escMd(m.title)}\n\n${escMd(m.narrative)}${facts}`
      })
      .join('\n\n')
    return [
      '',
      `## 会话日志 · ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      `> 来源：${adapter} 会话 · 置信度 ${confidence.toFixed(2)}`,
      '',
      bullets,
      '',
      '<details><summary>详情</summary>',
      '',
      detail,
      '',
      '</details>',
      '',
    ].join('\n')
  }

  private buildNewPage(
    concept: string,
    memories: Array<Omit<MemoryItem, 'id'>>,
    safeNodeTitle: string,
  ): string {
    const list = memories.map((m) => `- ${escMd(m.title)}`).join('\n')
    const wikilinkTarget = safeNodeTitle.replace(/[[\]]/g, '')
    return [
      '---',
      `title: ${concept}`,
      '---',
      '',
      `# ${concept}`,
      '',
      '> 由 Query Writeback 从会话提炼 · 待人工整理',
      '',
      `- 源节点：[[${wikilinkTarget}]]`,
      '',
      list,
      '',
    ].join('\n')
  }

  private clusterNovelConcepts(
    top: Array<Omit<MemoryItem, 'id'>>,
    graphId: string,
  ): Array<{ concept: string; memories: Array<Omit<MemoryItem, 'id'>> }> {
    const existing = new Set(this.titles.findExistingTitles(graphId).map((t) => normalizeWikiTitle(t).toLowerCase()))
    const byConcept = new Map<string, Array<Omit<MemoryItem, 'id'>>>()
    for (const m of top) {
      for (const c of m.concepts ?? []) {
        const key = normalizeWikiTitle(c).toLowerCase()
        if (existing.has(key)) continue
        if (!byConcept.has(c)) byConcept.set(c, [])
        byConcept.get(c)!.push(m)
      }
    }
    return [...byConcept.entries()]
      .filter(([, ms]) => ms.length >= MIN_CLUSTER)
      .map(([concept, memories]) => ({ concept, memories }))
  }
}
