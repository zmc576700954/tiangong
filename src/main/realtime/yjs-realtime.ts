/**
 * YjsRealtime — 全局 realtime 协调器：管理"一张图一个 Y.Doc"的池子，
 * 并在启动时把已有 SQLite 数据 hydrate 进内存、绑上 snapshot 防抖保存。
 *
 * 生命周期：
 *  - init(): 启动时调用一次
 *      1. 把 yjs_snapshots 老数据迁移回填（如果还没有快照）
 *      2. 给 graphs 表里每张图加载/构造 Y.Doc
 *      3. 给每张图绑上防抖保存 + 镜像写入 SQLite
 *  - getOrLoadDoc(graphId): 拿到当前内存中的 Y.Doc，没有就按需加载
 *  - shutdown(): 关闭所有图，flush 一次快照，停掉 WS server
 *
 * 该模块是 main 进程单例，由 ipc-handlers.ts 初始化。
 */

import type BetterSqlite3 from 'better-sqlite3'
import type * as Y from 'yjs'
import { YjsDocument } from './yjs-doc'
import { SnapshotStore } from './snapshot-store'
import { NodeRepository } from '../repositories/node-repository'
import { EdgeRepository } from '../repositories/edge-repository'
import { attachDiffHandlers } from './bidirectional-sync'
import { attachSnapshotPersistence } from './snapshot-persistence'
import { createYjsWsServer, type YjsWsServer } from './ws-server'
import { createLogger } from '../shared/logger'

const logger = createLogger('YjsRealtime')

export interface YjsRealtimeOptions {
  /** WS server 端口；默认从 WS_PORT env 或 1236（D10c 推荐） */
  wsPort?: number
  /** 启动时禁用 WS server（D10a 阶段允许纯内存模式） */
  disableWebSocket?: boolean
  /** snapshot 防抖 ms */
  snapshotDebounceMs?: number
}

export interface YjsRealtimeInitResult {
  migration: {
    scannedGraphs: number
    backfilled: number
    skipped: number
    errors: Array<{ graphId: string; error: string }>
  }
  loadedDocs: number
  wsStarted: boolean
}

/**
 * 维护 (graphId → YjsDocument) 映射 + 各自的 unsubscribe 函数。
 * 关闭时一并清理。
 */
export class YjsRealtime {
  private readonly docs = new Map<string, YjsDocument>()
  private readonly unsubscribers = new Map<string, () => void>()
  private store: SnapshotStore
  private wsServer: YjsWsServer | null = null
  private options: Required<Omit<YjsRealtimeOptions, 'disableWebSocket'>> & {
    disableWebSocket: boolean
  }
  private initialized = false

  constructor(
    private db: BetterSqlite3.Database,
    options: YjsRealtimeOptions = {},
  ) {
    this.store = new SnapshotStore(db)
    this.options = {
      wsPort: options.wsPort ?? Number(process.env.WS_PORT ?? '1236'),
      disableWebSocket: options.disableWebSocket ?? false,
      snapshotDebounceMs: options.snapshotDebounceMs ?? 1000,
    }
  }

  /**
   * 主入口：一次性启动。
   * 1. 迁移老数据 → 写 yjs_snapshots（如有老节点/边）
   * 2. 加载每张图的 doc
   * 3. 绑 diff → SQLite + 防抖快照保存
   * 4. 启动 WS server（如启用）
   */
  async init(): Promise<YjsRealtimeInitResult> {
    if (this.initialized) {
      logger.warn('YjsRealtime.init() called twice; ignoring')
      return {
        migration: { scannedGraphs: 0, backfilled: 0, skipped: 0, errors: [] },
        loadedDocs: this.docs.size,
        wsStarted: this.wsServer != null,
        }
    }
    this.initialized = true

    // 1) 老数据迁移
    const migration = this.store.migrateFromLegacy()
    logger.info(
      `legacy migration: ${migration.backfilled} backfilled / ${migration.skipped} skipped / ${migration.errors.length} errors (scanned ${migration.scannedGraphs})`,
    )

    // 2-3) 加载每张图的 doc
    const graphRows = this.db.prepare('SELECT id FROM graphs').all() as Array<{ id: string }>
    for (const g of graphRows) {
      this.loadDoc(g.id)
    }

    // 4) WS server
    let wsStarted = false
    if (!this.options.disableWebSocket) {
      try {
        this.wsServer = createYjsWsServer({
          port: this.options.wsPort,
          getDoc: (graphId) => {
            const doc = this.docs.get(graphId)
            return doc?.getYDoc()
          },
        })
        await this.wsServer.start()
        wsStarted = true
      } catch (err) {
        logger.warn(`WS server start failed (port ${this.options.wsPort}); continuing without WS sync:`, err)
        this.wsServer = null
      }
    }

    return {
      migration,
      loadedDocs: this.docs.size,
      wsStarted,
    }
  }

  /** 获取或按需加载一张图的 Y.Doc。 */
  getOrLoadDoc(graphId: string): YjsDocument | undefined {
    if (this.docs.has(graphId)) return this.docs.get(graphId)
    return this.loadDoc(graphId)
  }

  /** 关闭 realtime：flush 所有快照 + 关闭 WS server + 销毁所有 Y.Doc。 */
  async shutdown(): Promise<void> {
    for (const [graphId, unsub] of this.unsubscribers) {
      try {
        unsub()
      } catch (err) {
        logger.warn(`dispose failed for ${graphId}:`, err)
      }
    }
    this.unsubscribers.clear()
    for (const doc of this.docs.values()) {
      try {
        doc.destroy()
      } catch (err) {
        logger.warn('doc destroy failed:', err)
      }
    }
    this.docs.clear()
    if (this.wsServer) {
      await this.wsServer.stop()
      this.wsServer = null
    }
    this.initialized = false
  }

  /** 测试 / 调试用：当前已加载的 doc 数。 */
  size(): number {
    return this.docs.size
  }

  /** 测试 / 调试用：枚举已加载的 graphId。 */
  listLoadedGraphIds(): string[] {
    return [...this.docs.keys()]
  }

  private loadDoc(graphId: string): YjsDocument | undefined {
    if (this.docs.has(graphId)) return this.docs.get(graphId)

    // 优先从 snapshot 还原；没有就从 nodes/edges 行回填
    const snapshot = this.store.getLatest(graphId)
    const doc = new YjsDocument()
    if (snapshot) {
      try {
        doc.applyUpdate(snapshot.docState)
      } catch (err) {
        logger.warn(`failed to apply snapshot for ${graphId}; falling back to legacy:`, err)
      }
    } else {
      // 没有快照 —— 老数据已经在 init() 的 migrateFromLegacy() 阶段写入了；
      // 这里再读一次确认：snapshot 不存在的情况意味着该图是老 graphs 但没有节点
      // （例如全新空图），属于正常。
      const nodeRows = this.db
        .prepare('SELECT * FROM nodes WHERE graph_id = ?')
        .all(graphId) as Array<Record<string, unknown>>
      const edgeRows = this.db
        .prepare('SELECT * FROM edges WHERE graph_id = ?')
        .all(graphId) as Array<Record<string, unknown>>

      if (nodeRows.length === 0 && edgeRows.length === 0) {
        // 没有节点也没边 —— 不强写一个空快照（写入会让 updated_at 立刻跳动，渲染误以为有更新）
      } else {
        // migrateFromLegacy 没覆盖到的图 —— 走旧 fallback hydrate
        logger.warn(`graph ${graphId} has rows but no snapshot; lazy hydrate fallback`)
      }
    }

    this.docs.set(graphId, doc)

    // 绑 diff → SQLite + 防抖 snapshot
    const nodeRepo = new NodeRepository(this.db)
    const edgeRepo = new EdgeRepository(this.db)
    const disposeDiff = attachDiffHandlers(doc, { nodeRepo, edgeRepo })
    const disposeSnapshot = attachSnapshotPersistence(graphId, doc, this.store, {
      debounceMs: this.options.snapshotDebounceMs,
      onError: (err) => logger.warn(`snapshot save error for ${graphId}:`, err),
    })
    this.unsubscribers.set(graphId, () => {
      disposeDiff()
      disposeSnapshot()
    })

    return doc
  }
}

/** 模块级注册一个实例。供 ipc-handlers.ts 引用。 */
let _instance: YjsRealtime | null = null

export function setYjsRealtime(instance: YjsRealtime): void {
  _instance = instance
}

export function getYjsRealtime(): YjsRealtime | null {
  return _instance
}

/** 给已有 instance 上找 doc；未初始化返回 undefined。 */
export function lookupYDoc(graphId: string): Y.Doc | undefined {
  return _instance?.getOrLoadDoc(graphId)?.getYDoc()
}