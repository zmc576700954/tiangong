/**
 * YjsDocument — 一个图(graph)对应一个 Y.Doc 文档。
 *
 * 设计要点：
 * - 节点和边用 Y.Map<Id, Y.Map> 嵌套结构。每个实体是一个独立的 Y.Map，
 *   这样 patch 操作只产生对应字段的增量更新，而不是替换整个实体。
 * - meta 用扁平 Y.Map<key,value> 存图的元数据（name / projectPath / type 等）。
 * - 删除走 Y.Map.delete()（自然 tombstone），不再单独维护删除标记表。
 * - 所有写入走 `doc.transact()`，确保一次进入的应用原子。
 *
 * 用途：
 * - 持久化：定时把 `Y.encodeStateAsUpdate(doc)` 写入 yjs_snapshots 表。
 * - 启动加载：从 yjs_snapshots 读出二进制，applyUpdate 还原 Y.Doc。
 * - WebSocket 同步：通过 y-protocols/sync 与其它 client 增量同步（见 ws-server.ts）。
 */

import * as Y from 'yjs'

export type GraphType = 'online' | 'dev'

/** 与 GraphNode.reported 的字段对齐；JSON 字段（rules/metadata/content 等）原样存为对象 */
export interface NodeData {
  id: string
  type: string
  status: string
  title: string
  description?: string
  acceptanceCriteria?: unknown
  graphId: string
  graphType: GraphType
  parentId?: string
  rules?: unknown
  metadata?: unknown
  ownerRole?: string
  position: { x: number; y: number }
  content?: unknown
  communitySummary?: string
  communityLevel?: number
  communityId?: string
  contextRefs?: unknown
  wikiContent?: string
  wikiMeta?: unknown
  createdAt: string
  updatedAt: string
}

export interface EdgeData {
  id: string
  source: string
  target: string
  label?: string
  edgeType?: string
  graphId: string
  description?: string
  dataFlow?: string
  strength?: number
  content?: unknown
}

export type YjsChangeKind = 'create' | 'update' | 'delete'

export interface YjsChange {
  entity: 'node' | 'edge' | 'meta'
  kind: YjsChangeKind
  /** node/edge 的 id，或 meta 的 key */
  id: string
  /** 当前完整状态（create/update 时携带；delete 时省略） */
  data?: Record<string, unknown>
}

const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'
const META_KEY = 'meta'

/** 顶层 (深嵌套)的观察：转换后产出扁平的 (entity, kind, id, data) 列表 */
type DeepHandler = (changes: YjsChange[]) => void

export class YjsDocument {
  private readonly doc: Y.Doc
  /** 节点顶层 Y.Map：Y.Map<id, Y.Map<key, value>>。暴露给 free helper 用于深观察路由。 */
  readonly nodesMap: Y.Map<Y.Map<unknown>>
  /** 边顶层 Y.Map。同上。 */
  readonly edgesMap: Y.Map<Y.Map<unknown>>
  /** meta 顶层 Y.Map：Y.Map<key, value>。 */
  readonly metaMap: Y.Map<unknown>
  private observerDisposers: Array<() => void> = []

  constructor() {
    this.doc = new Y.Doc()
    this.nodesMap = this.doc.getMap<Y.Map<unknown>>(NODES_KEY)
    this.edgesMap = this.doc.getMap<Y.Map<unknown>>(EDGES_KEY)
    this.metaMap = this.doc.getMap<unknown>(META_KEY)
  }

  /** 用已有二进制状态构造；不修改传入的字节 */
  static fromUpdate(update: Uint8Array): YjsDocument {
    const inst = new YjsDocument()
    Y.applyUpdate(inst.doc, update)
    return inst
  }

  /** 编码全文档为二进制快照（用于持久化） */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc)
  }

  /** 合并一段二进制 update（用于从快照恢复 / 接收 peer 更新） */
  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update)
  }

  /** 暴露底层 Y.Doc，给 ws-server.ts 这种需要 y-protocols/sync 的场景 */
  getYDoc(): Y.Doc {
    return this.doc
  }

  /** 包一层事务；返回回调的返回值，便于调用方拿结果 */
  transaction<T>(fn: () => T): T {
    let result!: T
    this.doc.transact(() => {
      result = fn()
    })
    return result
  }

  // ---------- 节点 ----------

  /** 写入或替换一个节点（顶/底向：整实体覆盖） */
  setNode(id: string, data: NodeData): void {
    this.doc.transact(() => {
      const ymap = new Y.Map<unknown>()
      writeFields(ymap, data as unknown as Record<string, unknown>)
      this.nodesMap.set(id, ymap)
    }, 'yjs-setNode')
  }

  /** 局部更新一个节点；undefined 字段视为删除 */
  patchNode(id: string, patch: Partial<NodeData>): void {
    this.doc.transact(() => {
      const ymap = this.nodesMap.get(id)
      if (!ymap) {
        throw new Error(`patchNode: node ${id} not found`)
      }
      writeFields(ymap, patch as unknown as Record<string, unknown>)
    }, 'yjs-patchNode')
  }

  deleteNode(id: string): void {
    this.doc.transact(() => {
      this.nodesMap.delete(id)
    }, 'yjs-deleteNode')
  }

  getNode(id: string): NodeData | undefined {
    const ymap = this.nodesMap.get(id)
    if (!ymap) return undefined
    return readFields(ymap) as unknown as NodeData
  }

  /** 按 graphId 过滤；Y.Doc 里通常只存一张图，但保留 graphId 字段便于迁移期兼容多图混杂 */
  listNodes(graphId?: string): NodeData[] {
    const result: NodeData[] = []
    this.nodesMap.forEach((ymap: Y.Map<unknown>, _id: string) => {
      const obj = readFields(ymap) as unknown as NodeData
      if (!graphId || obj.graphId === graphId) result.push(obj)
    })
    return result
  }

  nodeCount(): number {
    return this.nodesMap.size
  }

  // ---------- 边 ----------

  setEdge(id: string, data: EdgeData): void {
    this.doc.transact(() => {
      const ymap = new Y.Map<unknown>()
      writeFields(ymap, data as unknown as Record<string, unknown>)
      this.edgesMap.set(id, ymap)
    }, 'yjs-setEdge')
  }

  patchEdge(id: string, patch: Partial<EdgeData>): void {
    this.doc.transact(() => {
      const ymap = this.edgesMap.get(id)
      if (!ymap) {
        throw new Error(`patchEdge: edge ${id} not found`)
      }
      writeFields(ymap, patch as unknown as Record<string, unknown>)
    }, 'yjs-patchEdge')
  }

  deleteEdge(id: string): void {
    this.doc.transact(() => {
      this.edgesMap.delete(id)
    }, 'yjs-deleteEdge')
  }

  getEdge(id: string): EdgeData | undefined {
    const ymap = this.edgesMap.get(id)
    if (!ymap) return undefined
    return readFields(ymap) as unknown as EdgeData
  }

  listEdges(graphId?: string): EdgeData[] {
    const result: EdgeData[] = []
    this.edgesMap.forEach((ymap: Y.Map<unknown>, _id: string) => {
      const obj = readFields(ymap) as unknown as EdgeData
      if (!graphId || obj.graphId === graphId) result.push(obj)
    })
    return result
  }

  edgeCount(): number {
    return this.edgesMap.size
  }

  // ---------- meta ----------

  getMeta<T = unknown>(key: string): T | undefined {
    return this.metaMap.get(key) as T | undefined
  }

  setMeta(key: string, value: unknown): void {
    this.metaMap.set(key, value)
  }

  deleteMeta(key: string): void {
    this.metaMap.delete(key)
  }

  // ---------- 观察 ----------

  /**
   * 注册深观察器。回调拿到一个扁平的 (entity, kind, id, data) 列表，
   * 每个事务合并后调用一次。返回取消订阅函数。
   *
   * 注意：data 字段携带实体的完整当前状态，便于 SQLite mirror 直接落盘，
   * 避免回调方还要重新走 getNode(id)。
   */
  observe(handler: DeepHandler): () => void {
    const deepObserver = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
      const changes: YjsChange[] = []
      for (const event of events) {
        collectChanges(event, this, changes)
      }
      if (changes.length > 0) {
        try {
          handler(changes)
        } catch (err) {
          // 观察器异常不能让事务回滚；记录并吞掉。
           
          console.error('YjsDocument observer threw:', err)
        }
      }
    }

    this.nodesMap.observeDeep(deepObserver)
    this.edgesMap.observeDeep(deepObserver)
    // meta 是扁平的，没必要 observeDeep。
    const metaObserver = (event: Y.YEvent<Y.Map<unknown>>) => {
      const mapEvent = event as Y.YMapEvent<unknown>
      const keys = mapEvent.changes?.keys
      const changes: YjsChange[] = []
      if (keys) {
        for (const [key, change] of keys) {
          if (change.action === 'delete') {
            changes.push({ entity: 'meta', kind: 'delete', id: String(key) })
          } else {
            changes.push({
              entity: 'meta',
              kind: change.action === 'add' ? 'create' : 'update',
              id: String(key),
              data: { value: this.metaMap.get(String(key)) },
            })
          }
        }
      }
      if (changes.length > 0) {
        try {
          handler(changes)
        } catch (err) {
           
          console.error('YjsDocument meta observer threw:', err)
        }
      }
    }
    this.metaMap.observe(metaObserver)

    const dispose = () => {
      this.nodesMap.unobserveDeep(deepObserver)
      this.edgesMap.unobserveDeep(deepObserver)
      this.metaMap.unobserve(metaObserver)
    }
    this.observerDisposers.push(dispose)
    return dispose
  }

  /** 清空所有观察器，关闭文档 */
  destroy(): void {
    for (const dispose of this.observerDisposers) {
      try { dispose() } catch { /* ignore */ }
    }
    this.observerDisposers = []
    this.doc.destroy()
  }
}

// ============================================================
// 内部工具
// ============================================================

/**
 * 把普通对象写入一个 Y.Map。undefined 视为"不写"，null 写入后读取仍是 null。
 * 这样 5.x 兼容 old_value !== undefined 的字段更新语义。
 */
function writeFields(ymap: Y.Map<unknown>, fields: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) {
      ymap.delete(k)
    } else {
      ymap.set(k, v)
    }
  }
}

/** 把 Y.Map 转回普通对象（深嵌套里的 Y.Map 已是嵌套对象，自动 JSON 可序列化） */
function readFields(ymap: Y.Map<unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  ymap.forEach((v: unknown, k: string) => {
    obj[k] = v
  })
  return obj
}

/** 从观察事件中提取 (entity, kind, id, data)。
 *
 * observeDeep 事件形态：
 * - 顶层事件：path = []，target = nodesMap/edgesMap 本身，event.changes.keys 包含
 *   新增/删除/替换的节点 id。这是 setNode/deleteEntity 触发的位置。
 * - 嵌套事件：path = [nodesMap, id, innerYMap]，target = innerYMap，event.changes.keys
 *   包含字段级修改。这是 patchEntity 触发的位置 —— 我们用 entity 粒度的 update
 *   表示，把整个实体现状塞 data。
 *
 * 两个分支的 entity id 都在 path[1]；顶层事件的 id 在 event.changes.keys。
 */
function collectChanges(
  event: Y.YEvent<Y.AbstractType<unknown>>,
  doc: YjsDocument,
  out: YjsChange[],
): void {
  const path = event.path

  // 顶层事件：path = []，target 是 nodesMap / edgesMap 本身。
  // 此时 event.changes.keys 包含被新增/删除/替换的实体 id（setNode / deleteNode 触发）。
  if (path.length === 0) {
    if (event.target === doc.nodesMap) {
      collectTopLevelChanges(event, 'node', (id) => doc.getNode(id) as unknown as Record<string, unknown> | undefined, out)
    } else if (event.target === doc.edgesMap) {
      collectTopLevelChanges(event, 'edge', (id) => doc.getEdge(id) as unknown as Record<string, unknown> | undefined, out)
    }
    return
  }

  // 嵌套事件：Yjs 把顶层 type 引用从 path 中省略（target 是内层 Y.Map / Y.Array）。
  // 形态：
  //   setNode 后 patchNode：path = [entityId, ...]，target = innerYMap；event.changes.keys 是字段级 delta。
  //   patchNode 单独（已存在节点）：path = [entityId]，target = innerYMap。
  // 因此 path[0] 就是 entityId。path[0] === event.target.parentSub 推不出，但可以用 target 判 entity：
  //   target 是 doc.nodesMap.get(path[0]) 的值 → 'node'；同理 edgesMap → 'edge'。
  const entityIdRaw = path[0]
  if (typeof entityIdRaw !== 'string' && typeof entityIdRaw !== 'number') return
  const entityId = String(entityIdRaw)

  let data: Record<string, unknown> | undefined
  let entity: 'node' | 'edge' | null = null
  if (event.target === doc.nodesMap.get(entityId)) {
    entity = 'node'
    data = doc.getNode(entityId) as unknown as Record<string, unknown> | undefined
  } else if (event.target === doc.edgesMap.get(entityId)) {
    entity = 'edge'
    data = doc.getEdge(entityId) as unknown as Record<string, unknown> | undefined
  }
  if (!entity || !data) return
  out.push({ entity, kind: 'update', id: entityId, data })
}

function collectTopLevelChanges(
  event: Y.YEvent<Y.AbstractType<unknown>>,
  entity: 'node' | 'edge',
  getter: (id: string) => Record<string, unknown> | undefined,
  out: YjsChange[],
): void {
  // event.changes.keys 在 Y.YMapEvent 上才有；类型守卫。
  const ymapEvent = event as Y.YMapEvent<unknown>
  const keys = ymapEvent.changes?.keys
  if (!keys) return
  for (const [key, change] of keys) {
    const id = String(key)
    if (change.action === 'delete') {
      out.push({ entity, kind: 'delete', id })
    } else {
      const data = getter(id)
      if (data) {
        out.push({
          entity,
          kind: change.action === 'add' ? 'create' : 'update',
          id,
          data,
        })
      }
    }
  }
}