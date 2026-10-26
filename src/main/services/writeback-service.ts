import type BetterSqlite3 from 'better-sqlite3'
import type { MemoryItem } from '@shared/types'
import type { WritebackItem, WritebackStatus, RollbackAction, RollbackResult } from '@shared/types/wiki'
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
  updateStatus(id: string, status: WritebackStatus, rollbackActions?: RollbackAction[]): void
  /** 记录 new-page 采纳时创建的节点 id（撤回按 id 定位页面）。 */
  setCreatedNodeId(id: string, nodeId: string): void
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

/**
 * 从 append-log 正文里取回真正的 `## 标题` 文本。
 *
 * 锚点必须来自**实际写入的内容**，不能来自 item.title：title 是「会话日志 · 日期」
 * （只到日），正文里的标题是「会话日志 · 日期 时间」（到分钟）。用 title 当锚点，
 * 幂等检查与撤回都定位不到真正写入的小节 —— 重复采纳会写两份，撤回永远跳过。
 */
function sectionHeadingText(content: string): string | null {
  const m = /^##\s+(.+?)\s*$/m.exec(content)
  return m ? m[1] : null
}

/** 正则元字符转义（标题里可能有 `·` `.` `(` 等）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 清洗 wikilink 目标标题：去掉括号/竖线（避免被解析成显示文本分隔），归一化空白 */
function sanitizeLinkTitle(s: string): string {
  return normalizeWikiTitle(s.replace(/[[\]|]/g, ''))
}

/** append-log 结构化输出（v9 拆分） */
interface AppendLogOutput {
  content: string
  details: string
  narrative: string
}

/** new-page 结构化输出（v9 拆分） */
interface NewPageOutput {
  content: string
  sourceNodeIds: string[]
  targetNodeTitle: string
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

    const appendLog = this.buildAppendLog(top, safeConfidence, now)
    created.push(this.repo.create({
      graphId: input.graphId,
      kind: 'append-log',
      targetNodeId: input.nodeId,
      title: `会话日志 · ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
      content: appendLog.content,
      details: appendLog.details,
      narrative: appendLog.narrative,
      sourceSessionId: input.sessionId,
      confidence: safeConfidence,
    }))

    for (const cluster of this.clusterNovelConcepts(top, input.graphId)) {
      const concept = stripNewlines(cluster.concept)
      const newPage = this.buildNewPage(concept, cluster.memories, safeNodeTitle)
      created.push(this.repo.create({
        graphId: input.graphId,
        kind: 'new-page',
        targetNodeId: input.nodeId, // 源节点 id，采纳时连边用
        title: concept,
        content: newPage.content,
        sourceNodeIds: newPage.sourceNodeIds,
        targetNodeTitle: newPage.targetNodeTitle,
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
      if (item.kind === 'append-log') {
        this.acceptAppendLog(item)
      } else {
        // 记下实际创建的节点 id：撤回按 id 定位页面，避免误删同名页面。
        const createdNodeId = this.acceptNewPage(item)
        if (createdNodeId !== undefined) {
          this.repo.setCreatedNodeId(itemId, createdNodeId)
        }
      }
      this.repo.updateStatus(itemId, 'accepted')
    }

    if (this.deps!.db) {
      this.deps!.db.transaction(doAccept)()
    } else {
      doAccept()
    }
  }

  /**
   * 撤回已采纳的写回项：恢复 accept 前的图状态。
   * - append-log：从目标节点的 wikiContent 中按 `## 标题` 行定位移除对应段落
   * - new-page：删除 accept 时创建的 wiki-page 节点 + 关联边（writeback-derived 语义边 + wiki-link 出/入边）
   *
   * 仅 accepted 可 rollback；非 accepted 抛 IpcError。
   * 部分副作用已被用户手动改动（节点已删 / 段落已被编辑）→ 跳过的动作计入 skippedActions。
   */
  rollback(itemId: string): RollbackResult {
    if (!this.deps) throw new IpcError('WritebackService.rollback 需要 nodeRepo/edgeRepo 依赖', ErrorCode.IPC_INVALID_ARGUMENT)
    const item = this.repo.findById(itemId)
    if (!item) throw new IpcError(`写回项不存在: ${itemId}`, ErrorCode.IPC_INVALID_ARGUMENT)
    if (item.status !== 'accepted') {
      throw new IpcError(`仅已采纳项可撤回，当前状态: ${item.status}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }

    const undone: RollbackAction[] = []
    const skipped: RollbackAction[] = []

    const doRollback = () => {
      if (item.kind === 'append-log') this.rollbackAppendLog(item, undone, skipped)
      else this.rollbackNewPage(item, undone, skipped)
      // 只审计**实际执行**的动作（WritebackItem.rollbackActions 的语义）。
      // 跳过的动作通过 RollbackResult.skippedActions 现场返回给调用方，
      // 混进审计列表会让历史面板把「没做的事」显示成做过。
      this.repo.updateStatus(itemId, 'rolled_back', undone)
    }

    if (this.deps!.db) {
      this.deps!.db.transaction(doRollback)()
    } else {
      doRollback()
    }
    return {
      success: true,
      status: 'rolled_back',
      undoneActions: undone,
      skippedActions: skipped,
    }
  }

  /**
   * 从目标节点 wikiContent 中移除 append-log 段落。
   * 锚定策略：定位 `## 标题` 行；从该行起切到下一个 `## ` 标题或文件末尾。
   * 段首回退一个 `\n`（accept 拼接留下的边界空行），让原文恢复原状。
   * 段落已不存在（用户手动改）→ skipped。
   *
   * 注意：append-log 总是 append 到 wikiContent 末尾，所以「下一标题」分支主要服务
   * 「用户手动在 accept 后追加了另一节」这种边角场景——段尾保留 1 个 `\n` 作为节间分隔。
   */
  private rollbackAppendLog(item: WritebackItem, undone: RollbackAction[], skipped: RollbackAction[]): void {
    const node = this.deps!.nodeRepo.findById(item.targetNodeId)
    if (!node) {
      skipped.push({
        kind: 'removed-section',
        description: `目标节点已被删除：${item.targetNodeId.slice(0, 12)}…，无法定位段落`,
      })
      return
    }
    const heading = sectionHeadingText(item.content)
    if (heading === null) {
      skipped.push({
        kind: 'removed-section',
        description: `写回项「${item.title}」的内容里找不到小节标题，无法定位段落`,
      })
      return
    }
    const current = node.wikiContent ?? ''
    const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm')
    const m = headingRe.exec(current)
    if (!m) {
      skipped.push({
        kind: 'removed-section',
        description: `未在「${node.title}」中找到段落：## ${heading}（可能已被手动编辑）`,
      })
      return
    }
    const headingIdx = m.index

    // 找下一个 ## 标题行作为段末索引
    const nextHeadingRe = /^##\s+/gm
    nextHeadingRe.lastIndex = headingIdx + m[0].length
    const nextMatch = nextHeadingRe.exec(current)
    const rawSectionEnd = nextMatch ? nextMatch.index : current.length

    // 段首回退一个 `\n`：accept 拼接时遗留 `\n\n`（原段尾 + append 段首），吃掉一个恢复原样
    let removeStart = headingIdx
    if (removeStart >= 1 && current[removeStart - 1] === '\n') {
      removeStart -= 1
    }

    // 段尾：accept 段尾自带 `\n`；若无下一个标题则连这个 `\n` 一并吃掉（恢复原段尾），
    // 若有下一个标题则保留 1 个 `\n` 作为下一节与原内容之间的分隔符（Markdown 段间空行）。
    let removeEnd = rawSectionEnd
    if (nextMatch && removeEnd > removeStart && current[removeEnd - 1] === '\n') {
      removeEnd -= 1
    }

    const removed = current.slice(0, removeStart) + current.slice(removeEnd)
    this.deps!.nodeRepo.update(node.id, { wikiContent: removed })
    undone.push({
      kind: 'removed-section',
      description: `已从「${node.title}」移除段落：## ${heading}`,
    })
    try {
      WikiLinkService.syncNodeLinks(node.id, this.deps!.nodeRepo, this.deps!.edgeRepo)
    } catch (err) {
      logger.error('rollbackAppendLog syncNodeLinks failed for', node.id, err)
    }
  }

  /**
   * 删除 new-page 创建的 wiki-page 节点及其关联边：
   * - writeback-derived 语义边（accept 时显式创建）
   * - 该节点作为 source 或 target 的 wiki-link 边（accept syncNodeLinks 同步产生）
   * 节点已被用户删除 → skipped；关联边已被清理 → 仅记 done。
   *
   * 定位方式：优先用 accept 时记下的节点 id。id 缺失（老数据）时退回
   * 「同名 wiki-page + 存在 writeback-derived 边」双重条件 —— 只按标题找会
   * 把同名但并非本项创建的页面一起删掉。
   */
  private rollbackNewPage(item: WritebackItem, undone: RollbackAction[], skipped: RollbackAction[]): void {
    const edges = this.deps!.edgeRepo.listByGraph(item.graphId)

    let pageId: string | undefined
    if (item.createdNodeId !== undefined) {
      const node = this.deps!.nodeRepo.findById(item.createdNodeId)
      if (node && node.type === 'wiki-page') pageId = node.id
      else if (!node) {
        skipped.push({
          kind: 'deleted-page',
          description: `页面「${item.title}」已被删除，无法自动撤回`,
        })
        return
      } else {
        skipped.push({
          kind: 'deleted-page',
          description: `页面「${item.title}」已被改成其他节点类型，无法自动撤回`,
        })
        return
      }
    } else {
      // 老数据没有 created_node_id：要求「同名 wiki-page」且「有 writeback-derived
      // 边指向它」才认定为本次创建，避免误删用户自己的同名页面。
      const candidate = this.deps!.nodeRepo
        .listByGraph(item.graphId)
        .find((n) => n.type === 'wiki-page' && n.title === item.title)
      if (candidate !== undefined) {
        const derived = edges.some(
          (e) =>
            e.source === item.targetNodeId &&
            e.target === candidate.id &&
            e.edgeType === 'semantic' &&
            e.label === 'writeback-derived',
        )
        if (derived) pageId = candidate.id
      }
    }

    if (pageId === undefined) {
      skipped.push({
        kind: 'deleted-page',
        description: `未找到由本写回项创建的页面「${item.title}」，无法自动撤回（页面可能被用户改名或已删除）`,
      })
      return
    }

    const related = edges.filter(
      (e) =>
        (e.source === pageId || e.target === pageId) &&
        (e.edgeType === 'wiki-link' || (e.edgeType === 'semantic' && e.label === 'writeback-derived')),
    )
    for (const edge of related) this.deps!.edgeRepo.delete(edge.id)
    if (related.length > 0) {
      undone.push({
        kind: 'deleted-edges',
        description: `已清理 ${related.length} 条关联边（writeback-derived / wiki-link）`,
      })
    }

    this.deps!.nodeRepo.delete(pageId)
    undone.push({
      kind: 'deleted-page',
      description: `已删除页面：${item.title}`,
    })
  }

  private acceptAppendLog(item: WritebackItem): void {
    const node = this.deps!.nodeRepo.findById(item.targetNodeId)
    if (!node) throw new IpcError('目标节点已删除，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
    const current = node.wikiContent ?? ''
    // 幂等：小节标题行已存在则跳过写入（外层仍标 accepted）。
    // 锚点取自**正文里真正写入的标题**（不是 item.title —— title 只到日，
    // 正文标题到分钟，两者不一致会让幂等检查永远不命中 → 重复采纳写两份）。
    const heading = sectionHeadingText(item.content)
    if (heading === null) throw new IpcError('写回项内容缺少小节标题，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
    const sectionRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm')
    if (sectionRe.test(current)) return
    this.deps!.nodeRepo.update(node.id, { wikiContent: current + item.content })
    try {
      WikiLinkService.syncNodeLinks(node.id, this.deps!.nodeRepo, this.deps!.edgeRepo)
    } catch (err) {
      logger.error('syncNodeLinks failed for', node.id, err)
    }
  }

  /**
   * 创建 wiki-page 节点并连边。
   *
   * @returns 新建节点的 id；同名页面已存在（本次什么都没创建）时返回 undefined。
   *   撤回必须靠这个 id 定位页面 —— 按标题找会误删同名的其他页面。
   */
  private acceptNewPage(item: WritebackItem): string | undefined {
    const source = this.deps!.nodeRepo.findById(item.targetNodeId) // new-page: targetNodeId 存源节点 id
    if (!source) throw new IpcError('源节点已删除，无法采纳', ErrorCode.IPC_INVALID_ARGUMENT)
    const existing = this.deps!.nodeRepo
      .listByGraph(item.graphId)
      .some((n) => n.title === item.title && n.type === 'wiki-page')
    if (existing) return undefined // 标题级幂等：同名 wiki-page 已存在，跳过创建
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
    return created.id
  }

  /**
   * 构造 append-log 写回项的三段内容：
   * - content：始终可见（## 标题 + 来源 meta + bullets 摘要）
   * - details：折叠详情（H3 标题 + narrative + facts）——前端用 `<details>` 包裹渲染
   * - narrative：仅 narrative 文本的连接（不包含 H3/facts），便于纯文本摘要展示
   *
   * 旧版「<details><summary>详情</summary>...</details>」内嵌 content 已废弃，
   * 拆分后 content 永远不嵌 markdown HTML 结构。
   */
  private buildAppendLog(
    top: Array<Omit<MemoryItem, 'id'>>,
    confidence: number,
    now: Date,
  ): AppendLogOutput {
    const adapter = top[0]?.adapter_name ?? 'agent'
    const bullets = top.map((m) => `- ${escMd(m.title)}`).join('\n')
    const narrative = top.map((m) => escMd(m.narrative)).join('\n\n')
    const detail = top
      .map((m) => {
        const facts = m.facts.length
          ? '\n\n' + m.facts.map((f) => `- ${escMd(f)}`).join('\n')
          : ''
        return `### ${escMd(m.title)}\n\n${escMd(m.narrative)}${facts}`
      })
      .join('\n\n')

    const content = [
      '',
      `## 会话日志 · ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      `> 来源：${adapter} 会话 · 置信度 ${confidence.toFixed(2)}`,
      '',
      bullets,
      '',
    ].join('\n')

    return { content, details: detail, narrative }
  }

  /**
   * 构造 new-page 写回项：
   * - content：frontmatter + H1 + 源 wikilink + bullet list
   * - sourceNodeIds：本簇记忆所属节点的 id 列表（去重）。当前实现是单节点
   *   （clusterNovelConcepts 只在单 session 的 memories 中聚类），但保留数组结构
   *   以便未来跨节点聚类时无缝升级。
   * - targetNodeTitle：源节点标题的快照，采纳时即使用户重命名/删除了源节点，UI 仍可展示。
   */
  private buildNewPage(
    concept: string,
    memories: Array<Omit<MemoryItem, 'id'>>,
    safeNodeTitle: string,
  ): NewPageOutput {
    const list = memories.map((m) => `- ${escMd(m.title)}`).join('\n')
    const wikilinkTarget = sanitizeLinkTitle(safeNodeTitle)
    const content = [
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

    const sourceNodeIds = Array.from(
      new Set(memories.map((m) => m.node_id).filter((id): id is string => typeof id === 'string' && id.length > 0)),
    )

    return { content, sourceNodeIds, targetNodeTitle: safeNodeTitle }
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
