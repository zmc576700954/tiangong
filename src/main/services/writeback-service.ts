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

export class WritebackService {
  constructor(
    private readonly repo: WritebackRepoLike,
    private readonly titles: NodeTitleSource,
  ) {}

  generate(input: GenerateInput): WritebackItem[] {
    if (input.memories.length === 0) return []
    if (this.repo.findBySession(input.sessionId).length > 0) return []

    const top = [...input.memories]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, TOP_N)
    const confidence = top.reduce((s, m) => s + (m.confidence ?? 0), 0) / top.length

    const created: WritebackItem[] = []
    created.push(this.repo.create({
      graphId: input.graphId,
      kind: 'append-log',
      targetNodeId: input.nodeId,
      title: `会话日志 · ${new Date().toISOString().slice(0, 10)}`,
      content: this.buildAppendLog(top),
      sourceSessionId: input.sessionId,
      confidence,
    }))

    for (const cluster of this.clusterNovelConcepts(top, input.graphId)) {
      created.push(this.repo.create({
        graphId: input.graphId,
        kind: 'new-page',
        targetNodeId: input.nodeId, // 源节点 id，采纳时连边用
        title: cluster.concept,
        content: this.buildNewPage(cluster.concept, cluster.memories, input),
        sourceSessionId: input.sessionId,
        confidence,
      }))
    }
    return created
  }

  private buildAppendLog(top: Array<Omit<MemoryItem, 'id'>>): string {
    const adapter = top[0]?.adapter_name ?? 'agent'
    const confidence = top.reduce((s, m) => s + (m.confidence ?? 0), 0) / top.length
    const bullets = top.map((m) => `- ${m.title}`).join('\n')
    const detail = top
      .map((m) => `### ${m.title}\n\n${m.narrative}${m.facts.length ? '\n\n' + m.facts.map((f) => `- ${f}`).join('\n') : ''}`)
      .join('\n\n')
    return [
      '',
      `## 会话日志 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
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

  private buildNewPage(concept: string, memories: Array<Omit<MemoryItem, 'id'>>, input: GenerateInput): string {
    const list = memories.map((m) => `- ${m.title}`).join('\n')
    return [
      '---',
      `title: ${concept}`,
      '---',
      '',
      `# ${concept}`,
      '',
      '> 由 Query Writeback 从会话提炼 · 待人工整理',
      '',
      `- 源节点：[[${input.nodeTitle}]]`,
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
