/**
 * Graph Lint 修复服务：执行 LintIssue.fix 描述的修复动作。
 *
 * 严格 scope 边界：所有写操作都走 NodeRepository / EdgeRepository（已自带事务与校验）。
 * 任何"创建节点"必须先通过 findById 拿到 source 的 graphType，避免误建到错误的图。
 *
 * 修复成功后返回新节点 / 更新节点 ID；失败抛 BizGraphError 由 IPC 层转译。
 *
 * 当前支持的 fix.kind：
 * - create-stub-page    : 给断链目标创建一个空白 wiki-page，并同步源节点出边
 * - add-frontmatter     : 给节点补最小 frontmatter（title / createdAt），不覆盖现有键
 * - normalize-case      : 把节点 title 归一化（小写 + 合并空白），同时把全图 wikiContent
 *                         内的 `[[OldTitle]]` 全部替换为 `[[NewTitle]]` 并重算相关节点出边
 */

import type { GraphEdge, GraphNode, GraphType } from '@shared/types'
import type { LintFixAction, LintFixResult } from '@shared/types/wiki'
import { BizGraphError, ErrorCode } from '../errors'
import { normalizeWikiTitle } from './markdown-utils'
import { WikiLinkService } from '../services/wiki-link-service'

export interface FixNodeRepo {
  findById(id: string): GraphNode | null
  listByGraph(graphId: string): GraphNode[]
  create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode
  update(id: string, data: Partial<GraphNode>): GraphNode
}
export interface FixEdgeRepo {
  create(data: Omit<GraphEdge, 'id'>): GraphEdge
  delete(id: string): void
  listByGraph(graphId: string): GraphEdge[]
}

export class LintFixService {
  /**
   * 执行一条 fix。返回结果含受影响节点 ID（创建 → 新节点；其余 → 被改节点）。
   */
  static apply(
    action: LintFixAction,
    nodeRepo: FixNodeRepo,
    edgeRepo: FixEdgeRepo,
  ): LintFixResult {
    switch (action.kind) {
      case 'create-stub-page':
        return LintFixService.createStubPage(action.payload as CreateStubPayload, nodeRepo, edgeRepo)
      case 'add-frontmatter':
        return LintFixService.addFrontmatter(action.payload as NodeIdPayload, nodeRepo)
      case 'normalize-case':
        return LintFixService.normalizeCase(action.payload as NormalizeCasePayload, nodeRepo, edgeRepo)
      default: {
        const exhaustive: never = action.kind
        throw new BizGraphError(`未知的 fix.kind: ${String(exhaustive)}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
  }

  /**
   * 给断链目标创建一个空白 wiki-page，并同步源节点出边使 wiki-link 立即可解析。
   * 若目标已存在（按标题归一化 + 小写命中），直接视为"已修复"，返回已存在节点的 ID。
   */
  static createStubPage(
    payload: CreateStubPayload,
    nodeRepo: FixNodeRepo,
    edgeRepo: FixEdgeRepo,
  ): LintFixResult {
    const { sourceNodeId, targetTitle } = payload
    if (typeof sourceNodeId !== 'string' || !sourceNodeId) {
      throw new BizGraphError('create-stub-page 需要 sourceNodeId', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const rawTitle = typeof targetTitle === 'string' ? targetTitle : ''
    const normalized = normalizeWikiTitle(rawTitle)
    if (!normalized) {
      throw new BizGraphError('create-stub-page 需要非空 targetTitle', ErrorCode.IPC_INVALID_ARGUMENT)
    }

    const source = nodeRepo.findById(sourceNodeId)
    if (!source) {
      throw new BizGraphError(`源节点不存在: ${sourceNodeId}`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    }

    // 同名已存在（大小写不敏感）→ 视为已修复，直接同步源边即可
    const existing = nodeRepo
      .listByGraph(source.graphId)
      .find(
        (n) =>
          n.type === 'wiki-page' &&
          normalizeWikiTitle(n.title).toLowerCase() === normalized.toLowerCase(),
      )
    if (existing) {
      WikiLinkService.syncNodeLinks(sourceNodeId, nodeRepo, edgeRepo)
      return { ok: true, nodeId: existing.id }
    }

    const created = nodeRepo.create({
      type: 'wiki-page',
      status: 'draft',
      title: normalized,
      graphId: source.graphId,
      graphType: source.graphType as GraphType,
      position: { x: 0, y: 0 },
      acceptanceCriteria: [],
      wikiContent: `# ${normalized}\n\n`,
    })
    // 同步源节点出边：原断链的 [[normalized]] 现在解析到新建 stub
    WikiLinkService.syncNodeLinks(sourceNodeId, nodeRepo, edgeRepo)
    return { ok: true, nodeId: created.id }
  }

  /**
   * 给节点补最小 frontmatter：title（当前标题）+ createdAt（节点原 createdAt）。
   * 已有 frontmatter 字段全部保留，仅补缺失键。
   */
  static addFrontmatter(payload: NodeIdPayload, nodeRepo: FixNodeRepo): LintFixResult {
    const { nodeId } = payload
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new BizGraphError('add-frontmatter 需要 nodeId', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const node = nodeRepo.findById(nodeId)
    if (!node) {
      throw new BizGraphError(`节点不存在: ${nodeId}`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    }
    const existing = (node.wikiMeta as Record<string, unknown> | undefined)?.frontmatter
    const merged: Record<string, unknown> = {
      ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    }
    if (typeof merged.title !== 'string' || merged.title.length === 0) {
      merged.title = node.title
    }
    if (typeof merged.createdAt !== 'string' || merged.createdAt.length === 0) {
      merged.createdAt = node.createdAt
    }
    const nextMeta = {
      ...(node.wikiMeta ?? {}),
      frontmatter: merged,
    }
    nodeRepo.update(nodeId, { wikiMeta: nextMeta })
    return { ok: true, nodeId }
  }

  /**
   * 把节点 title 归一化（小写 + 合并空白），并把全图 wikiContent 中的
   * `[[<oldTitle>]]` / `[[<oldTitle>|...]]` 全部替换为 `[[<newTitle>]]`。
   * 受影响的非 stub 节点 wiki-link 出边需要重算。
   */
  static normalizeCase(
    payload: NormalizeCasePayload,
    nodeRepo: FixNodeRepo,
    edgeRepo: FixEdgeRepo,
  ): LintFixResult {
    const { nodeId, newTitle } = payload
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new BizGraphError('normalize-case 需要 nodeId', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (typeof newTitle !== 'string' || !newTitle.trim()) {
      throw new BizGraphError('normalize-case 需要非空 newTitle', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const node = nodeRepo.findById(nodeId)
    if (!node) {
      throw new BizGraphError(`节点不存在: ${nodeId}`, ErrorCode.AGENT_SESSION_NOT_FOUND)
    }
    const oldTitle = node.title
    const normalizedNew = normalizeWikiTitle(newTitle)
    if (oldTitle === normalizedNew) {
      return { ok: true, nodeId } // 已是目标形态
    }

    // 1) 改本节点 title
    nodeRepo.update(nodeId, { title: normalizedNew })

    // 2) 全图扫描：把所有页面正文中的 `[[<oldTitle>]]` / `[[<oldTitle>|...]]` 替换
    //    （大小写不敏感，避免漏掉同样大小写不规范的其他写法）
    const oldTitlePattern = escapeRegex(oldTitle)
    const re = new RegExp(
      `\\[\\[\\s*${oldTitlePattern}(\\s*\\|[^\\]\\n]+)?\\s*\\]\\]`,
      'gi',
    )
    const updatedIds = new Set<string>([nodeId])
    for (const page of nodeRepo.listByGraph(node.graphId)) {
      if (page.type !== 'wiki-page') continue
      if (!page.wikiContent) continue
      if (!re.test(page.wikiContent)) continue
      // re.test 会推进 lastIndex，复位后再 replace
      re.lastIndex = 0
      const newContent = page.wikiContent.replace(re, (_match, display) => {
        return display
          ? `[[${normalizedNew}${display}]]`
          : `[[${normalizedNew}]]`
      })
      nodeRepo.update(page.id, { wikiContent: newContent })
      updatedIds.add(page.id)
    }

    // 3) 重算受影响节点的 wiki-link 出边
    for (const id of updatedIds) {
      try {
        WikiLinkService.syncNodeLinks(id, nodeRepo, edgeRepo)
      } catch {
        // 单节点落边失败不阻断整体修复；调用方下次 lint 会再次提示
      }
    }

    return { ok: true, nodeId }
  }
}

interface CreateStubPayload {
  sourceNodeId?: unknown
  targetTitle?: unknown
}

interface NodeIdPayload {
  nodeId?: unknown
}

interface NormalizeCasePayload {
  nodeId?: unknown
  newTitle?: unknown
}

/** 转义正则元字符，用于构造 `[[<oldTitle>]]` 匹配模式 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
