import type BetterSqlite3 from 'better-sqlite3'
import type { MemoryItem } from '@shared/types'
import type { WritebackItem, WritebackStatus } from '@shared/types/wiki'
import type { NodeRepository } from '../repositories/node-repository'
import type { EdgeRepository } from '../repositories/edge-repository'
import { normalizeWikiTitle } from '../wiki/markdown-utils'
import { createLogger } from '../shared/logger'
import { IpcError, ErrorCode } from '../errors'
import { WikiLinkService } from './wiki-link-service'

const logger = createLogger('WritebackService')

export interface WritebackRepoLike {
  create(data: Omit<WritebackItem, 'id' | 'status' | 'createdAt' | 'resolvedAt'>): WritebackItem
  findBySession(sourceSessionId: string): WritebackItem[]
  findById(id: string): WritebackItem | null
  updateStatus(id: string, status: WritebackStatus): void
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

/** YAML 双引号标量转义：concept 来自 agent 产出，直接拼接会破坏 frontmatter */
function escYaml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 清洗 wikilink 目标标题：去掉括号/竖线（避免被解析成显示文本分隔），归一化空白 */
function sanitizeLinkTitle(s: string): string {
  return normalizeWikiTitle(s.replace(/[[\]|]/g, ''))
}

export class WritebackService {
  constructor(
    private readonly repo: WritebackRepoLike,
    private readonly titles: NodeTitleSource,
    private readonly deps?: { nodeRepo: NodeRepository; edgeRepo: EdgeRepository; db?: BetterSqlite3.Database },
  ) {}

  generate(input: GenerateInput, now: Date = new Date()): WritebackItem[] {
    if (input.memories.length === 0) return []
    if (this.repo.findBySession(input.sessionId).length > 0) return []

    const top = [...input.memories]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, TOP_N)
    const confidence = top.reduce((s, m) => s + (m.confidence ?? 0), 0) / top.length
    const safeConfidence = Number.isFinite(confidence) ? confidence : 0

    const safeNodeTitle = stripNewlines(input.nodeTitle)
    const created: WritebackItem[] = []
    created.push(this.repo.create({
      graphId: input.graphId,
      kind: 'append-log',
      targetNodeId: input.nodeId,
      title: `会话日志 · ${now.toISOString().slice(0, 10)}`,
      content: this.buildAppendLog(top, safeConfidence, now),
      sourceSessionId: input.sessionId,
      confidence: safeConfidence,
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
        confidence: safeConfidence,
      }))
    }
    return created
  }

  /**
   * 丢弃待审项：仅 pending → discarded；其他状态幂等不变；未知 id 静默返回
   */
  discard(itemId: string): void {
    const item = this.repo.findById(itemId)
    if (!item || item.status !== 'pending') return
    this.repo.updateStatus(itemId, 'discarded')
  }

  /**
   * 采纳写回项：append-log 幂等追加到目标节点 wikiContent；new-page 建 wiki-page 节点并连边。
   * 幂等：非 pending 直接返回；小节标题已存在时跳过写入但仍标 accepted。
   */
  accept(itemId: string): void {
    if (!this.deps) throw new IpcError('WritebackService.accept 需要 nodeRepo/edgeRepo 依赖', ErrorCode.IPC_INVALID_ARGUMENT)
    const item = this.repo.findById(itemId)
    if (!item) throw new IpcError(`写回项不存在: ${itemId}`, ErrorCode.IPC_INVALID_ARGUMENT)
    if (item.status !== 'pending') return // 幂等：已处理直接返回

    const doAccept = () => {
      if (item.kind === 'append-log') this.acceptAppendLog(item)
      else this.acceptNewPage(item)
      this.repo.updateStatus(itemId, 'accepted')
    }

    if (this.deps!.db) {
      this.deps!.db.transaction(doAccept)()
    } else {
      doAccept()
    }
  }

  private acceptAppendLog(item: WritebackItem): void {
    const node = this.deps!.nodeRepo.findById(item.targetNodeId)
    if (!node) throw new IpcError('目标节点已删除，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
    const current = node.wikiContent ?? ''
    // 幂等：小节标题行已存在则跳过写入（外层仍标 accepted）。
    // 按「## 标题」行匹配，正文里恰好提到该日期字符串不触发误跳过。
    const sectionRe = new RegExp(`^##\\s+${item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
    if (sectionRe.test(current)) return
    this.deps!.nodeRepo.update(node.id, { wikiContent: current + item.content })
    try {
      WikiLinkService.syncNodeLinks(node.id, this.deps!.nodeRepo, this.deps!.edgeRepo)
    } catch (err) {
      logger.error('syncNodeLinks failed for', node.id, err)
    }
  }

  private acceptNewPage(item: WritebackItem): void {
    const source = this.deps!.nodeRepo.findById(item.targetNodeId) // new-page: targetNodeId 存源节点 id
    if (!source) throw new IpcError('源节点已删除，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
    const existing = this.deps!.nodeRepo
      .listByGraph(item.graphId)
      .some((n) => n.title === item.title && n.type === 'wiki-page')
    if (existing) return // 标题级幂等：同名 wiki-page 已存在，跳过创建
    const created = this.deps!.nodeRepo.create({
      graphId: item.graphId,
      graphType: source.graphType,
      type: 'wiki-page',
      status: 'confirmed',
      title: item.title,
      wikiContent: item.content,
      position: { x: source.position.x + 280, y: source.position.y + 120 },
    })
    try {
      WikiLinkService.syncNodeLinks(created.id, this.deps!.nodeRepo, this.deps!.edgeRepo)
    } catch (err) {
      logger.error('syncNodeLinks failed for', created.id, err)
    }
    this.deps!.edgeRepo.create({
      graphId: item.graphId,
      source: source.id,
      target: created.id,
      edgeType: 'semantic',
      label: 'writeback-derived',
    })
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
    const wikilinkTarget = sanitizeLinkTitle(safeNodeTitle)
    return [
      '---',
      `title: "${escYaml(concept)}"`,
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
