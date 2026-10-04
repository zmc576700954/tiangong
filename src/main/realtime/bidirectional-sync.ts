/**
 * BidirectionalSync — Y.Doc ↔ SQLite 镜像写入层（D10a 同步层）。
 *
 * 设计：D10a 阶段 Y.Doc 仍是 main-process 内存中的权威，
 * SQLite 是 mirror（保证现有 query 不改）。Y.Doc 任意深嵌套变更 →
 * `attachDiffHandlers` 注册观察器 → 通过 NodeRepository / EdgeRepository
 * 把变更写入 SQLite。
 *
 * 注意：
 * - 仅镜像 Y.Doc → SQLite 方向。SQLite → Y.Doc 方向的写入仍由 IPC handler
 *   在 SQLite 操作后显式调用 `applySqliteChangesToYDoc()` 完成（见
 *   graph.ts 中各 create/update/delete 调用方）。
 * - NodeRepository.update 已经包含 validateNodeTypeTransition 校验；镜像写不会绕过。
 */

import type { GraphNode, GraphEdge } from '@shared/types'
import type { NodeRepository } from '../repositories/node-repository'
import type { EdgeRepository } from '../repositories/edge-repository'
import { type YjsDocument, type YjsChange, type NodeData, type EdgeData } from './yjs-doc'

export interface SyncTarget {
  nodeRepo: NodeRepository
  edgeRepo: EdgeRepository
}

export interface MirrorOptions {
  /** 自定义 logger；不传则用 console.error */
  onError?: (err: unknown, change: YjsChange) => void
}

/** 把 Y.Doc 的深观察事件镜像到 SQLite repositories。返回取消订阅函数。 */
export function attachDiffHandlers(
  doc: YjsDocument,
  target: SyncTarget,
  options: MirrorOptions = {},
): () => void {
  const onError = options.onError ?? ((err) => {
     
    console.error('[YjsSync] apply change failed:', err)
  })

  return doc.observe((changes) => {
    for (const change of changes) {
      try {
        applyOneToSqlite(change, target)
      } catch (err) {
        onError(err, change)
      }
    }
  })
}

/** 把单个 Y.Doc 变更落 SQLite。 */
function applyOneToSqlite(change: YjsChange, target: SyncTarget): void {
  if (change.entity === 'node') {
    if (change.kind === 'delete') {
      target.nodeRepo.delete(change.id)
      return
    }
    if (!change.data) return
    const nodeData = change.data as unknown as GraphNode
    if (change.kind === 'create') {
      const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = nodeData
      void _id; void _c; void _u
      target.nodeRepo.create(rest)
    } else {
      target.nodeRepo.update(change.id, nodeData)
    }
    return
  }

  if (change.entity === 'edge') {
    if (change.kind === 'delete') {
      target.edgeRepo.delete(change.id)
      return
    }
    if (!change.data) return
    const edgeData = change.data as unknown as GraphEdge
    if (change.kind === 'create') {
      const { id: _id, ...rest } = edgeData
      void _id
      target.edgeRepo.create(rest)
    } else {
      target.edgeRepo.update(change.id, edgeData)
    }
    return
  }

  // meta 不在镜像范围（当前 meta 只用于 in-memory 配置）
}

/**
 * 反向：从 SQLite rows 构造 YjsDocument（启动 hydrate 用）。
 * 调用方传入已经格式化的 NodeData / EdgeData 列表。
 */
export function populateFromRows(
  doc: YjsDocument,
  nodes: NodeData[],
  edges: EdgeData[],
): void {
  doc.transaction(() => {
    for (const node of nodes) {
      doc.setNode(node.id, node)
    }
    for (const edge of edges) {
      doc.setEdge(edge.id, edge)
    }
  })
}