/**
 * Graph IPC Handlers
 * 图、节点、边、Bug 的 CRUD 操作
 */

import type BetterSqlite3 from 'better-sqlite3'
import * as fs from 'fs/promises'
import type { GraphService } from '../services/graph-service'
import { NodeRepository } from '../repositories/node-repository'
import { EdgeRepository } from '../repositories/edge-repository'
import { BugRepository } from '../repositories/bug-repository'
import { type SnapshotRepository } from '../repositories/snapshot-repository'
import type { TypedHandle } from './utils'
import type { GraphNode, BugNode, GraphType, NodeStatus, GraphFetchOptions } from '@shared/types'
import { validateTransition, validateBugTransition } from '@shared/state-machine'
import { WikiIndexService } from '../services/wiki-index-service'
import { WikiLinkService } from '../services/wiki-link-service'
import { GraphComputeService } from '../wiki/graph-compute-service'
import { GraphLintService } from '../wiki/graph-lint-service'
import { LlmIngestService, type AgentRunner } from '../wiki/llm-ingest-service'
import { IngestService } from '../wiki/ingest-service'
import { sendPromptViaAgent } from '../agent/send-and-wait'
import type { AgentManager } from '../agent/agent-manager'
import type { IngestMode } from '@shared/types/wiki'
import { validateNodeMetadata } from '../memory/node-schema-registry'
import { VALID_NODE_TYPES } from '../services/graph-service'
import { nodeTypeRegistry } from '../shared/node-type-registry'
import { IpcError, ErrorCode } from '../errors'
import { createLogger } from '../shared/logger'
import { ensureString, ensureOptionalNumber, validateProjectPath, MAX_ID_LEN } from './utils'

const logger = createLogger('GraphIPC')

/** wiki:parseContent 的 content 最大长度（512 KB） */
const MAX_WIKI_CONTENT_LEN = 512 * 1024

export function registerGraphHandlers(
  db: BetterSqlite3.Database,
  typedHandle: TypedHandle,
  graphService: GraphService,
  snapshotRepo: SnapshotRepository,
  agentManager: AgentManager,
  overrides?: { nodeRepo?: NodeRepository; edgeRepo?: EdgeRepository; agentRunner?: AgentRunner },
): void {
  const nodeRepo = overrides?.nodeRepo ?? new NodeRepository(db)
  const edgeRepo = overrides?.edgeRepo ?? new EdgeRepository(db)
  const bugRepo = new BugRepository(db)

  /** wikiContent 变更后同步 wiki-link 边（失败仅记录，不阻断节点操作） */
  function syncWikiLinks(nodeId: string): void {
    try {
      WikiLinkService.syncNodeLinks(nodeId, nodeRepo, edgeRepo)
    } catch (err) {
      logger.error('syncNodeLinks failed for', nodeId, err)
    }
  }

  const NODE_STATUS_VALUES = ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder'] as const
  const GRAPH_TYPE_VALUES = ['online', 'dev'] as const
  const MAX_TITLE_LEN = 200
  const MAX_DESCRIPTION_LEN = 2000

  function isValidPosition(pos: unknown): pos is { x: number; y: number } {
    return (
      pos !== null &&
      typeof pos === 'object' &&
      typeof (pos as Record<string, unknown>).x === 'number' &&
      typeof (pos as Record<string, unknown>).y === 'number'
    )
  }

  function isValidNodeType(type: string): boolean {
    return VALID_NODE_TYPES.includes(type as GraphNode['type']) || nodeTypeRegistry.has(type)
  }

  function isPlainObject(val: unknown): val is Record<string, unknown> {
    return val !== null && typeof val === 'object' && !Array.isArray(val)
  }

  function validateNodeContent(label: string, val: unknown): void {
    if (val !== undefined && !isPlainObject(val)) {
      throw new IpcError(`${label} must be an object`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
  }

  function validateNodeCreate(data: unknown): void {
    if (!data || typeof data !== 'object') {
      throw new IpcError('Node data must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const node = data as Record<string, unknown>
    const type = ensureString('type', node.type, 32)
    if (!isValidNodeType(type)) {
      throw new IpcError(`Invalid node type: ${type}. Allowed: ${VALID_NODE_TYPES.join(', ')}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const status = ensureString('status', node.status, 32)
    if (!NODE_STATUS_VALUES.includes(status as NodeStatus)) {
      throw new IpcError(`Invalid node status: ${status}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    ensureString('title', node.title, MAX_TITLE_LEN)
    ensureString('graphId', node.graphId, MAX_ID_LEN)
    const graphType = ensureString('graphType', node.graphType, 32)
    if (!GRAPH_TYPE_VALUES.includes(graphType as GraphType)) {
      throw new IpcError(`Invalid graph type: ${graphType}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (!isValidPosition(node.position)) {
      throw new IpcError('Node position must have numeric x and y', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    validateNodeContent('content', node.content)
    if (node.communitySummary !== undefined && typeof node.communitySummary !== 'string') {
      throw new IpcError('communitySummary must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    ensureOptionalNumber('communityLevel', node.communityLevel)
    if (node.wikiContent !== undefined && typeof node.wikiContent !== 'string') {
      throw new IpcError('wikiContent must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (node.wikiMeta !== undefined && !isPlainObject(node.wikiMeta)) {
      throw new IpcError('wikiMeta must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
  }

  function validateNodeUpdate(id: string, data: unknown): void {
    ensureString('id', id, MAX_ID_LEN)
    if (!data || typeof data !== 'object') {
      throw new IpcError('Node update data must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const node = data as Record<string, unknown>
    if (node.wikiContent !== undefined) {
      if (typeof node.wikiContent !== 'string') {
        throw new IpcError('wikiContent must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (node.wikiMeta !== undefined) {
      if (node.wikiMeta !== null && (typeof node.wikiMeta !== 'object' || Array.isArray(node.wikiMeta))) {
        throw new IpcError('wikiMeta must be an object or null', ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (node.title !== undefined) ensureString('title', node.title, MAX_TITLE_LEN)
    if (node.description !== undefined) {
      if (typeof node.description !== 'string' || node.description.length > MAX_DESCRIPTION_LEN) {
        throw new IpcError(`description must be a string with max length ${MAX_DESCRIPTION_LEN}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (node.status !== undefined) {
      const status = ensureString('status', node.status, 32)
      if (!NODE_STATUS_VALUES.includes(status as NodeStatus)) {
        throw new IpcError(`Invalid node status: ${status}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (node.type !== undefined) {
      const type = ensureString('type', node.type, 32)
      if (!isValidNodeType(type)) {
        throw new IpcError(`Invalid node type: ${type}. Allowed: ${VALID_NODE_TYPES.join(', ')}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (node.graphType !== undefined) {
      const graphType = ensureString('graphType', node.graphType, 32)
      if (!GRAPH_TYPE_VALUES.includes(graphType as GraphType)) {
        throw new IpcError(`Invalid graph type: ${graphType}`, ErrorCode.IPC_INVALID_ARGUMENT)
      }
    }
    if (node.position !== undefined && !isValidPosition(node.position)) {
      throw new IpcError('Node position must have numeric x and y', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    validateNodeContent('content', node.content)
    if (node.communitySummary !== undefined && typeof node.communitySummary !== 'string') {
      throw new IpcError('communitySummary must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    ensureOptionalNumber('communityLevel', node.communityLevel)
    if (node.wikiContent !== undefined && typeof node.wikiContent !== 'string') {
      throw new IpcError('wikiContent must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (node.wikiMeta !== undefined && !isPlainObject(node.wikiMeta)) {
      throw new IpcError('wikiMeta must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
  }

  // ---------- 图操作 ----------
  typedHandle('graph:create', async (_, data) => {
    return graphService.createGraph(data)
  })

  typedHandle('graph:list', async () => {
    return graphService.listGraphs()
  })

  typedHandle('graph:get', async (_, id: string, options?: GraphFetchOptions) => {
    return graphService.getGraph(id, options)
  })

  typedHandle('graph:delete', async (_, id) => {
    await graphService.deleteGraph(id)
    return true
  })

  typedHandle('graph:derive', async (_, sourceGraphId: string, name?: string) => {
    return graphService.deriveGraph(sourceGraphId, name)
  })

  // ---------- 节点操作 ----------
  typedHandle('node:create', async (_, data) => {
    validateNodeCreate(data)
    const node = nodeRepo.create(data as Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>)
    if (node.type === 'wiki-page' && node.wikiContent) syncWikiLinks(node.id)
    return node
  })

  typedHandle('node:createBatch', async (_, nodesData: unknown) => {
    if (!Array.isArray(nodesData)) {
      throw new IpcError('nodesData must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    for (const data of nodesData) {
      validateNodeCreate(data)
    }
    const created = nodeRepo.createBatch(nodesData as Array<Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>>)
    for (const node of created) {
      if (node.type === 'wiki-page' && node.wikiContent) syncWikiLinks(node.id)
    }
    return created
  })

  typedHandle('node:update', async (_, id: string, data: Partial<GraphNode>) => {
    validateNodeUpdate(id, data)
    if (data.status !== undefined) {
      const currentStatus = await nodeRepo.getStatus(id)
      if (currentStatus !== null && currentStatus !== data.status) {
        validateTransition(currentStatus, data.status)
      }
    }
    let warnings: string[] = []
    if (data.type && data.metadata) {
      try {
        const validation = validateNodeMetadata(data.type, data.metadata as Record<string, unknown>)
        if (validation?.warnings) {
          warnings = validation.warnings
        }
      } catch {
        // Non-blocking: if validation fails, just proceed without warnings
      }
    }
    const node = await nodeRepo.update(id, data)
    if (data.wikiContent !== undefined) syncWikiLinks(id)
    return { ...node, warnings }
  })

  typedHandle('node:delete', async (_, id) => {
    await nodeRepo.delete(id)
    return true
  })

  typedHandle('node:batchUpdatePositions', async (_, updates) => {
    await nodeRepo.batchUpdatePositions(updates as Array<{ id: string; x: number; y: number }>)
    return true
  })

  // ---------- 边操作 ----------
  typedHandle('edge:create', async (_, data) => {
    if ((data as { edgeType?: unknown }).edgeType === 'wiki-link') {
      throw new IpcError('wiki-link edges are managed by WikiLinkService and cannot be created manually', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    return edgeRepo.create(data)
  })

  typedHandle('edge:update', async (_, id, data) => {
    return edgeRepo.update(id, data)
  })

  typedHandle('edge:delete', async (_, id) => {
    await edgeRepo.delete(id)
    return true
  })

  // ---------- Bug 操作 ----------
  typedHandle('bug:create', async (_, data) => {
    return bugRepo.create(data)
  })

  typedHandle('bug:update', async (_, id: string, data: Partial<BugNode>) => {
    if (data.status !== undefined) {
      const currentStatus = await bugRepo.getStatus(id)
      if (currentStatus !== null && currentStatus !== data.status) {
        validateBugTransition(currentStatus, data.status)
      }
    }
    return bugRepo.update(id, data)
  })

  typedHandle('bug:delete', async (_, id) => {
    await bugRepo.delete(id)
    return true
  })

  typedHandle('bug:listByNode', async (_, nodeId) => {
    return bugRepo.listByNode(nodeId)
  })

  // ---------- 快照操作 ----------
  typedHandle('snapshot:create', async (_, graphId: string, name: string) => {
    const graphData = await graphService.getGraph(graphId)
    if (!graphData) throw new IpcError('Graph not found', ErrorCode.IPC_HANDLER_ERROR)
    return snapshotRepo.create(graphId, name, graphData.nodes, graphData.edges)
  })

  typedHandle('snapshot:list', async (_, graphId: string) => {
    return snapshotRepo.listByGraph(graphId)
  })

  typedHandle('snapshot:load', async (_, id: string) => {
    return snapshotRepo.load(id)
  })

  typedHandle('snapshot:delete', async (_, id: string) => {
    await snapshotRepo.delete(id)
    return true
  })

  typedHandle('wiki:resolveLink', async (_, graphId: string, targetTitle: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    ensureString('targetTitle', targetTitle, MAX_TITLE_LEN)
    return WikiIndexService.resolveWikiLink(graphId, targetTitle, nodeRepo)
  })

  typedHandle('wiki:parseContent', async (_, graphId: string, content: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    ensureString('content', content, MAX_WIKI_CONTENT_LEN)
    return WikiLinkService.parseContent(graphId, content, nodeRepo)
  })

  typedHandle('wiki:getBacklinks', async (_, nodeId: string) => {
    ensureString('nodeId', nodeId, MAX_ID_LEN)
    const nodes = WikiLinkService.getBacklinks(nodeId, nodeRepo, edgeRepo)
    return nodes.map((n) => ({ id: n.id, title: n.title }))
  })

  typedHandle('wiki:findDangling', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    return WikiLinkService.findDanglingLinks(graphId, nodeRepo)
  })

  typedHandle('wiki:ingestFiles', async (_, graphId: string, filePaths: string[], mode?: IngestMode) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new IpcError('filePaths must be a non-empty array', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    // 批量上限 100：IngestService 第二遍逐节点 syncNodeLinks 是 O(N²)，限制批量控制开销
    if (filePaths.length > 100) {
      throw new IpcError('filePaths exceeds max batch size 100', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const graphData = await graphService.getGraph(graphId)
    if (!graphData) {
      throw new IpcError(`Graph not found: ${graphId}`, ErrorCode.IPC_HANDLER_ERROR)
    }
    // 路径安全：拒绝系统目录（与 validateProjectPath 同一防线）
    const validated = filePaths.map((p) => {
      ensureString('filePath', p, 1024)
      return validateProjectPath(p)
    })
    const resolvedMode = mode ?? 'rule'
    if (resolvedMode !== 'rule' && resolvedMode !== 'llm') {
      throw new IpcError(`Invalid ingest mode: ${resolvedMode}`, ErrorCode.IPC_INVALID_ARGUMENT)
    }
    if (resolvedMode === 'llm') {
      const projectPath = graphData.graph.projectPath
      if (!projectPath) {
        throw new IpcError('该图无 projectPath，无法使用 LLM 提炼导入', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      const agentRunner =
        overrides?.agentRunner ??
        ((prompt: string) =>
          sendPromptViaAgent(agentManager, projectPath, prompt, {
            nodeTitle: 'Wiki LLM 提炼导入',
            timeoutMs: 120_000,
          }))
      return LlmIngestService.ingestWithLlm(
        graphId, validated, graphData.graph.type, nodeRepo, edgeRepo,
        (p) => fs.readFile(p, 'utf-8'),
        agentRunner,
      )
    }
    return IngestService.ingestFiles(
      graphId, validated, graphData.graph.type, nodeRepo, edgeRepo,
      (p) => fs.readFile(p, 'utf-8'),
    )
  })

  typedHandle('wiki:computeCommunities', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    return GraphComputeService.computeCommunities(graphId, nodeRepo, edgeRepo)
  })

  typedHandle('wiki:lint', async (_, graphId: string) => {
    ensureString('graphId', graphId, MAX_ID_LEN)
    return GraphLintService.lint(graphId, nodeRepo, edgeRepo)
  })

  // 注意: graph:initFromProject 已在 ipc/project.ts 中注册（含路径校验），此处不重复注册
}
