/**
 * BidirectionalSync tests — 验证 Y.Doc → SQLite 镜像写入语义。
 *
 * 覆盖：
 * - 节点 create / update / delete 正确路由到对应 repo 方法
 * - 边 create / update / delete 同样
 * - patchNode 触发 update 路径，传完整现状
 * - meta 事件不写 SQLite（meta 是内存配置）
 * - 单个 change 失败不阻断后续
 * - populateFromRows 把 rows 灌回 Y.Doc
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  attachDiffHandlers,
  populateFromRows,
} from '../bidirectional-sync'
import { YjsDocument, type NodeData, type EdgeData } from '../yjs-doc'
import type { NodeRepository } from '../../repositories/node-repository'
import type { EdgeRepository } from '../../repositories/edge-repository'

function makeNode(overrides: Partial<NodeData> = {}): NodeData {
  return {
    id: 'n1',
    type: 'feature',
    status: 'draft',
    title: 'T1',
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeEdge(overrides: Partial<EdgeData> = {}): EdgeData {
  return {
    id: 'e1',
    source: 'n1',
    target: 'n2',
    graphId: 'g1',
    ...overrides,
  }
}

interface MockState {
  nodeCreates: number
  nodeUpdates: number
  nodeDeletes: number
  edgeCreates: number
  edgeUpdates: number
  edgeDeletes: number
  lastNodeUpdate: { id: string; data: unknown } | null
}

function createMockRepos() {
  const state: MockState = {
    nodeCreates: 0,
    nodeUpdates: 0,
    nodeDeletes: 0,
    edgeCreates: 0,
    edgeUpdates: 0,
    edgeDeletes: 0,
    lastNodeUpdate: null,
  }
  const nodeRepo = {
    create: vi.fn((data: unknown) => {
      state.nodeCreates += 1
      return { ...(data as object), id: 'node_generated' }
    }),
    update: vi.fn((id: string, data: unknown) => {
      state.nodeUpdates += 1
      state.lastNodeUpdate = { id, data }
      return { ...(data as object), id }
    }),
    delete: vi.fn((id: string) => {
      state.nodeDeletes += 1
      return id
    }),
  } as unknown as NodeRepository

  const edgeRepo = {
    create: vi.fn((data: unknown) => {
      state.edgeCreates += 1
      return { ...(data as object), id: 'edge_generated' }
    }),
    update: vi.fn((id: string, data: unknown) => {
      state.edgeUpdates += 1
      return { ...(data as object), id }
    }),
    delete: vi.fn((id: string) => {
      state.edgeDeletes += 1
      return id
    }),
  } as unknown as EdgeRepository

  return { nodeRepo, edgeRepo, state }
}

describe('BidirectionalSync — Y.Doc → SQLite 镜像', () => {
  let doc: YjsDocument
  let nodeRepo: NodeRepository
  let edgeRepo: EdgeRepository
  let state: MockState

  beforeEach(() => {
    doc = new YjsDocument()
    const mocks = createMockRepos()
    nodeRepo = mocks.nodeRepo
    edgeRepo = mocks.edgeRepo
    state = mocks.state
  })

  it('setNode 触发 nodeRepo.create', () => {
    attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    doc.setNode('n1', makeNode({ id: 'n1', title: 'A' }))
    expect(state.nodeCreates).toBe(1)
    expect(state.nodeUpdates).toBe(0)
    expect(state.nodeDeletes).toBe(0)
  })

  it('patchNode 触发 nodeRepo.update，且传完整现状', () => {
    attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    doc.setNode('n1', makeNode({ id: 'n1', title: 'A' }))
    doc.patchNode('n1', { title: 'B' })

    expect(state.nodeCreates).toBe(1)
    expect(state.nodeUpdates).toBe(1)
    expect(state.lastNodeUpdate?.id).toBe('n1')
    // 完整现状包含被改字段的最新值
    expect((state.lastNodeUpdate?.data as NodeData).title).toBe('B')
  })

  it('deleteNode 触发 nodeRepo.delete', () => {
    attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    doc.setNode('n1', makeNode({ id: 'n1' }))
    doc.deleteNode('n1')
    expect(state.nodeDeletes).toBe(1)
  })

  it('setEdge / patchEdge / deleteEdge 路由到 edgeRepo', () => {
    attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    doc.setEdge('e1', makeEdge({ id: 'e1', label: 'flow' }))
    doc.patchEdge('e1', { label: 'rename' })
    doc.deleteEdge('e1')
    expect(state.edgeCreates).toBe(1)
    expect(state.edgeUpdates).toBe(1)
    expect(state.edgeDeletes).toBe(1)
  })

  it('setMeta 不写 SQLite（meta 是内存配置）', () => {
    attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    doc.setMeta('k', 'v')
    doc.deleteMeta('k')
    expect(state.nodeCreates + state.nodeUpdates + state.nodeDeletes).toBe(0)
    expect(state.edgeCreates + state.edgeUpdates + state.edgeDeletes).toBe(0)
  })

  it('onError 在 change 失败时被调用，后续 change 继续处理', () => {
    const onError = vi.fn()
    // 让第一次 create 抛错；后续 create 不受影响。
    const realCreate = (nodeRepo as unknown as { create: (data: unknown) => unknown }).create
    let callCount = 0
    ;(nodeRepo as unknown as { create: (data: unknown) => unknown }).create = (data: unknown) => {
      callCount += 1
      if (callCount === 1) throw new Error('boom')
      return realCreate(data)
    }
    attachDiffHandlers(doc, { nodeRepo, edgeRepo }, { onError })

    doc.setNode('n1', makeNode({ id: 'n1' }))
    doc.setNode('n2', makeNode({ id: 'n2' }))

    expect(onError).toHaveBeenCalledTimes(1)
    // 第一个 create 抛错未计入 state.nodeCreates；第二个 create 成功，所以是 1。
    expect(state.nodeCreates).toBe(1)
  })

  it('unsubscribe 后变更不再写 SQLite', () => {
    const dispose = attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    dispose()
    doc.setNode('n1', makeNode({ id: 'n1' }))
    expect(state.nodeCreates).toBe(0)
  })

  it('populateFromRows 把 nodes/edges 列表灌回 Y.Doc', () => {
    const nodes: NodeData[] = [
      makeNode({ id: 'n1', title: 'A' }),
      makeNode({ id: 'n2', title: 'B' }),
    ]
    const edges: EdgeData[] = [makeEdge({ id: 'e1', source: 'n1', target: 'n2' })]
    populateFromRows(doc, nodes, edges)
    expect(doc.nodeCount()).toBe(2)
    expect(doc.edgeCount()).toBe(1)
    expect(doc.getNode('n1')?.title).toBe('A')
  })
})