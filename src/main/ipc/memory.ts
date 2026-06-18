/**
 * Memory IPC Handlers
 * 会话记忆检索的 IPC 通道
 * 借鉴 claude-mem 的 MCP 搜索工具设计，但适配为内部 IPC 通道
 */

import { getMemoryStore } from '../memory/memory-store'
import { getWaterlineSync } from '../memory/waterline-sync'
import type { TypedHandle } from './utils'
import type { MemoryKind } from '@shared/types'
import { createLogger } from '../shared/logger'
import { IpcError, ErrorCode } from '../errors'

const logger = createLogger('MemoryIPC')

/** 渲染端输入字符串硬上限：防止主进程被任意大小入参冻结 */
const MAX_QUERY_LEN = 2000
const MAX_ID_LEN = 200
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 20
const MIN_PRUNE_DAYS = 1
const MAX_PRUNE_DAYS = 3650
const ALLOWED_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>([
  'investigation',
  'fix',
  'review_finding',
  'decision',
  'pattern',
  'lesson',
])

function ensureString(name: string, value: unknown, maxLen: number, allowEmpty = false): string {
  if (typeof value !== 'string') {
    throw new IpcError(`${name} must be a string`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (!allowEmpty && value.length === 0) {
    throw new IpcError(`${name} must not be empty`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (value.length > maxLen) {
    throw new IpcError(`${name} exceeds max length (${maxLen})`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  return value
}

function ensureOptionalString(name: string, value: unknown, maxLen: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return ensureString(name, value, maxLen)
}

function ensureOptionalLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new IpcError('limit must be a positive number', ErrorCode.IPC_INVALID_ARGUMENT)
  }
  return Math.min(Math.floor(value), MAX_LIMIT)
}

function ensureOptionalKind(value: unknown): MemoryKind | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new IpcError('kind must be a string', ErrorCode.IPC_INVALID_ARGUMENT)
  }
  if (!ALLOWED_KINDS.has(value as MemoryKind)) {
    throw new IpcError(`Unknown memory kind: ${value}`, ErrorCode.IPC_INVALID_ARGUMENT)
  }
  return value as MemoryKind
}

/** 全文搜索最小有效 query 长度（去掉空白后）：防止短查询触发全表 LIKE 扫描 */
const MIN_SEARCH_QUERY_LEN = 2

/** 已恢复水位线的项目 ID 集合（避免重复 restore） */
const restoredProjects = new Set<string>()

/**
 * 懒加载恢复水位线：首次按 projectId 检索时触发
 *
 * 非阻塞：restore 失败仅打日志，不阻塞当前 IPC 调用。
 * 幂等：同一 projectId 只 restore 一次。
 */
function ensureWaterlineRestored(projectId: string | undefined): void {
  if (!projectId || restoredProjects.has(projectId)) return
  const waterline = getWaterlineSync()
  waterline.restore(projectId).then(() => {
    restoredProjects.add(projectId)
  }).catch((err) => {
    logger.warn(`Failed to restore waterline for ${projectId}:`, err)
    // Don't add to restoredProjects so next call will retry
  })
}

export function registerMemoryHandlers(typedHandle: TypedHandle): void {
  /**
   * 全文搜索记忆
   *
   * 拒绝空白/过短 query：
   *   - 空白会让 FTS5 抛 syntax error → store.search 退化为 LIKE '%  %'，
   *     在 100k 行表上是数百 ms 的同步开销，乘以 IPC 速率限制 20 req/s 足以阻塞主进程。
   *   - 至少要求去空白后长度 >= MIN_SEARCH_QUERY_LEN，且包含可识别字符。
   */
  typedHandle('memory:search', async (_event, query: string, options?: {
    projectId?: string
    kind?: MemoryKind
    limit?: number
  }) => {
    const safeQuery = ensureString('query', query, MAX_QUERY_LEN)
    const trimmed = safeQuery.trim()
    if (trimmed.length < MIN_SEARCH_QUERY_LEN || !/[\p{L}\p{N}]/u.test(trimmed)) {
      throw new IpcError(
        `query must contain at least ${MIN_SEARCH_QUERY_LEN} non-whitespace characters with at least one letter or digit`,
        ErrorCode.IPC_INVALID_ARGUMENT,
      )
    }
    const safeOptions = {
      projectId: ensureOptionalString('projectId', options?.projectId, MAX_ID_LEN),
      kind: ensureOptionalKind(options?.kind),
      limit: ensureOptionalLimit(options?.limit),
    }
    ensureWaterlineRestored(safeOptions.projectId)
    const store = getMemoryStore()
    const results = await store.search(trimmed, safeOptions)
    logger.debug(`Memory search "${trimmed}" returned ${results.length} results`)
    return results
  })

  /**
   * 获取最近记忆（用于上下文注入和 UI 展示）
   */
  typedHandle('memory:getRecent', async (_event, options?: {
    projectId?: string
    nodeId?: string
    limit?: number
  }) => {
    const safeOptions = {
      projectId: ensureOptionalString('projectId', options?.projectId, MAX_ID_LEN),
      nodeId: ensureOptionalString('nodeId', options?.nodeId, MAX_ID_LEN),
      limit: ensureOptionalLimit(options?.limit),
    }
    ensureWaterlineRestored(safeOptions.projectId)
    const store = getMemoryStore()
    return store.getRecent(safeOptions)
  })

  /**
   * 获取指定节点的所有关联记忆
   */
  typedHandle('memory:getByNode', async (_event, nodeId: string, limit?: number) => {
    const safeNodeId = ensureString('nodeId', nodeId, MAX_ID_LEN)
    const safeLimit = ensureOptionalLimit(limit)
    const store = getMemoryStore()
    return store.getByNode(safeNodeId, safeLimit)
  })

  /**
   * 获取指定会话的所有记忆
   */
  typedHandle('memory:getBySession', async (_event, sessionId: string, limit?: number) => {
    const safeSessionId = ensureString('sessionId', sessionId, MAX_ID_LEN)
    const safeLimit = ensureOptionalLimit(limit, MAX_LIMIT)
    const store = getMemoryStore()
    return store.getBySession(safeSessionId, safeLimit)
  })

  /**
   * 获取记忆统计（按类型分组）
   */
  typedHandle('memory:getStats', async (_event, projectId?: string) => {
    const safeProjectId = ensureOptionalString('projectId', projectId, MAX_ID_LEN)
    const store = getMemoryStore()
    return store.getStats(safeProjectId)
  })

  /**
   * 获取跨适配器记忆
   */
  typedHandle('memory:getCrossAdapter', async (_event, projectId: string, excludeAdapter: string, limit?: number) => {
    const safeProjectId = ensureString('projectId', projectId, MAX_ID_LEN)
    const safeExcludeAdapter = ensureString('excludeAdapter', excludeAdapter, MAX_ID_LEN, /* allowEmpty */ true)
    const safeLimit = ensureOptionalLimit(limit)
    const store = getMemoryStore()
    return store.getCrossAdapter(safeProjectId, safeExcludeAdapter, safeLimit)
  })

  /**
   * 删除指定会话的记忆
   *
   * 授权说明：渲染端必须同时提供 projectId 才可删除会话记忆。
   * 此 IPC 入口不提供"按 sessionId 全局删除"的能力，避免在未知 projectId
   * 的情况下被未授权调用方枚举/删除其他项目的会话记忆。
   */
  typedHandle('memory:delete', async (_event, sessionId: string, projectId: string) => {
    const safeSessionId = ensureString('sessionId', sessionId, MAX_ID_LEN)
    const safeProjectId = ensureString('projectId', projectId, MAX_ID_LEN)
    const store = getMemoryStore()
    const count = await store.deleteBySessionScoped(safeSessionId, safeProjectId)
    // Signal user rejection to AdaptiveConfig so pruning aggressiveness adapts
    if (count > 0) {
      const { getAdaptiveConfig } = await import('../adaptive-config')
      getAdaptiveConfig().recordMetric('pruneHalfLifeDays', 1)
      getAdaptiveConfig().recordMetric('memoryMaxItems', 1)
    }
    logger.info(`Deleted ${count} memories for session ${safeSessionId} in project ${safeProjectId}`)
    return count
  })

  /**
   * 手动清理过期低置信度记忆
   *
   * 限制 daysThreshold ∈ [1, 3650] 防止 0/负数清空全表。
   */
  typedHandle('memory:prune', async (_event, daysThreshold?: number) => {
    let days = daysThreshold ?? 90
    if (typeof days !== 'number' || !Number.isFinite(days)) {
      throw new IpcError('daysThreshold must be a finite number', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    days = Math.floor(days)
    if (days < MIN_PRUNE_DAYS || days > MAX_PRUNE_DAYS) {
      throw new IpcError(
        `daysThreshold must be between ${MIN_PRUNE_DAYS} and ${MAX_PRUNE_DAYS}`,
        ErrorCode.IPC_INVALID_ARGUMENT,
      )
    }
    const store = getMemoryStore()
    const count = await store.pruneStale(days)
    logger.info(`Pruned ${count} stale memories (threshold: ${days} days)`)
    return count
  })

  /**
   * 获取概念演进链
   *
   * 返回从最早版本到最新版本的完整演进序列，按 version ASC 排序。
   */
  typedHandle('memory:getEvolutionChain', async (_event, concept: string, projectId: string) => {
    const safeConcept = ensureString('concept', concept, MAX_QUERY_LEN)
    const safeProjectId = ensureString('projectId', projectId, MAX_ID_LEN)
    const store = getMemoryStore()
    return store.getEvolutionChain(safeConcept, safeProjectId)
  })

  /**
   * 回填旧记忆条目的 embedding 向量
   *
   * 对 embedding IS NULL 的条目生成向量并更新。
   * 使用 initializeWithTimeout 防止模型下载阻塞；初始化失败时抛出 IpcError。
   */
  typedHandle('memory:backfillEmbeddings', async (_event, projectId: string) => {
    const safeProjectId = ensureString('projectId', projectId, MAX_ID_LEN)
    const store = getMemoryStore()
    // Lazy-import EmbeddingService to avoid circular deps
    const { getEmbeddingService } = await import('../memory/embedding-service')
    const embeddingService = getEmbeddingService()
    if (!embeddingService.isReady()) {
      const ok = await embeddingService.initializeWithTimeout(60_000)
      if (!ok) {
        throw new IpcError('Embedding service is unavailable: initialization failed or timed out', ErrorCode.IPC_HANDLER_ERROR)
      }
    }
    const count = await store.backfillEmbeddings(
      safeProjectId,
      (text: string) => embeddingService.generateEmbedding(text),
    )
    logger.info(`Backfilled ${count} embeddings for project ${safeProjectId}`)
    return count
  })

  /**
   * 基于衰减模型的记忆清理
   *
   * 根据半衰期衰减计算置信度，删除低于阈值或超出项目记忆上限的条目。
   * config 参数均为可选，有合理默认值。
   */
  typedHandle('memory:pruneWithDecay', async (_event, projectId: string, config?: {
    baseHalfLife?: number
    minConfidence?: number
    maxItems?: number
  }) => {
    const safeProjectId = ensureString('projectId', projectId, MAX_ID_LEN)
    const safeConfig: {
      baseHalfLife?: number
      minConfidence?: number
      maxItems?: number
    } = {}
    if (config?.baseHalfLife !== undefined && config.baseHalfLife !== null) {
      if (typeof config.baseHalfLife !== 'number' || !Number.isFinite(config.baseHalfLife) || config.baseHalfLife < 1 || config.baseHalfLife > 3650) {
        throw new IpcError('baseHalfLife must be a finite number between 1 and 3650', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      safeConfig.baseHalfLife = Math.floor(config.baseHalfLife)
    }
    if (config?.minConfidence !== undefined && config.minConfidence !== null) {
      if (typeof config.minConfidence !== 'number' || !Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1) {
        throw new IpcError('minConfidence must be a finite number between 0 and 1', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      safeConfig.minConfidence = config.minConfidence
    }
    if (config?.maxItems !== undefined && config.maxItems !== null) {
      if (typeof config.maxItems !== 'number' || !Number.isFinite(config.maxItems) || config.maxItems < 1 || config.maxItems > 100000) {
        throw new IpcError('maxItems must be a finite number between 1 and 100000', ErrorCode.IPC_INVALID_ARGUMENT)
      }
      safeConfig.maxItems = Math.floor(config.maxItems)
    }
    const store = getMemoryStore()
    const count = await store.pruneWithDecay(safeProjectId, safeConfig)
    logger.info(`Pruned ${count} memories with decay for project ${safeProjectId}`)
    return count
  })
}
