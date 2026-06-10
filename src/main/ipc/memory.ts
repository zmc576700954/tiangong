/**
 * Memory IPC Handlers
 * 会话记忆检索的 IPC 通道
 * 借鉴 claude-mem 的 MCP 搜索工具设计，但适配为内部 IPC 通道
 */

import { getMemoryStore } from '../memory/memory-store'
import type { TypedHandle } from './utils'
import type { MemoryKind } from '@shared/types'
import { createLogger } from '../shared/logger'

const logger = createLogger('MemoryIPC')

export function registerMemoryHandlers(typedHandle: TypedHandle): void {
  /**
   * 全文搜索记忆
   */
  typedHandle('memory:search', async (_event, query: string, options?: {
    projectId?: string
    kind?: MemoryKind
    limit?: number
  }) => {
    const store = getMemoryStore()
    const results = await store.search(query, options)
    logger.debug(`Memory search "${query}" returned ${results.length} results`)
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
    const store = getMemoryStore()
    return store.getRecent(options)
  })

  /**
   * 获取指定节点的所有关联记忆
   */
  typedHandle('memory:getByNode', async (_event, nodeId: string, limit?: number) => {
    const store = getMemoryStore()
    return store.getByNode(nodeId, limit)
  })

  /**
   * 获取指定会话的所有记忆
   */
  typedHandle('memory:getBySession', async (_event, sessionId: string) => {
    const store = getMemoryStore()
    return store.getBySession(sessionId)
  })

  /**
   * 获取记忆统计（按类型分组）
   */
  typedHandle('memory:getStats', async (_event, projectId?: string) => {
    const store = getMemoryStore()
    return store.getStats(projectId)
  })

  /**
   * 获取跨适配器记忆
   */
  typedHandle('memory:getCrossAdapter', async (_event, projectId: string, excludeAdapter: string, limit?: number) => {
    const store = getMemoryStore()
    return store.getCrossAdapter(projectId, excludeAdapter, limit)
  })

  /**
   * 删除指定会话的记忆
   */
  typedHandle('memory:delete', async (_event, sessionId: string) => {
    const store = getMemoryStore()
    const count = await store.deleteBySession(sessionId)
    logger.info(`Deleted ${count} memories for session ${sessionId}`)
    return count
  })

  /**
   * 手动清理过期低置信度记忆
   */
  typedHandle('memory:prune', async (_event, daysThreshold?: number) => {
    const store = getMemoryStore()
    const count = await store.pruneStale(daysThreshold ?? 90)
    logger.info(`Pruned ${count} stale memories (threshold: ${daysThreshold ?? 90} days)`)
    return count
  })
}
