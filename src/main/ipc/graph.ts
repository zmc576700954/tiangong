/**
 * Graph IPC Handlers
 * 图、节点、边、Bug 的 CRUD 操作
 */

import type { Client } from '@libsql/client'
import type { GraphService } from '../services/graph-service'
import { NodeRepository } from '../repositories/node-repository'
import { EdgeRepository } from '../repositories/edge-repository'
import { BugRepository } from '../repositories/bug-repository'
import { type SnapshotRepository } from '../repositories/snapshot-repository'
import type { TypedHandle } from './utils'
import type { GraphNode, BugNode, GraphType, NodeStatus } from '@shared/types'
import { validateTransition, validateBugTransition } from '@shared/state-machine'
import { validateNodeMetadata } from '../memory/node-schema-registry'
import { VALID_NODE_TYPES } from '../services/graph-service'
import { IpcError, ErrorCode } from '../errors'
import { ensureString, MAX_ID_LEN } from './utils'

export function registerGraphHandlers(db: Client, typedHandle: TypedHandle, graphService: GraphService, snapshotRepo: SnapshotRepository): void {
  const nodeRepo = new NodeRepository(db)
  const edgeRepo = new EdgeRepository(db)
  const bugRepo = new BugRepository(db)

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

  function validateNodeCreate(data: unknown): void {
    if (!data || typeof data !== 'object') {
      throw new IpcError('Node data must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const node = data as Record<string, unknown>
    const type = ensureString('type', node.type, 32)
    if (!VALID_NODE_TYPES.includes(type as GraphNode['type'])) {
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
  }

  function validateNodeUpdate(id: string, data: unknown): void {
    ensureString('id', id, MAX_ID_LEN)
    if (!data || typeof data !== 'object') {
      throw new IpcError('Node update data must be an object', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    const node = data as Record<string, unknown>
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
      if (!VALID_NODE_TYPES.includes(type as GraphNode['type'])) {
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
  }

  // ---------- 图操作 ----------
  typedHandle('graph:create', async (_, data) => {
    return graphService.createGraph(data)
  })

  typedHandle('graph:list', async () => {
    return graphService.listGraphs()
  })

  typedHandle('graph:get', async (_, id) => {
    return graphService.getGraph(id)
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
    return nodeRepo.create(data as Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>)
  })

  typedHandle('node:createBatch', async (_, nodesData: unknown) => {
    if (!Array.isArray(nodesData)) {
      throw new IpcError('nodesData must be an array', ErrorCode.IPC_INVALID_ARGUMENT)
    }
    for (const data of nodesData) {
      validateNodeCreate(data)
    }
    return nodeRepo.createBatch(nodesData as Array<Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>>)
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

  // 注意: graph:initFromProject 已在 ipc/project.ts 中注册（含路径校验），此处不重复注册
}
