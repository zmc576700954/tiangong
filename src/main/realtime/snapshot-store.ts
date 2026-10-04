/**
 * SnapshotStore — Y.Doc 二进制快照的 SQLite 持久化层。
 *
 * 表 yjs_snapshots 一行一张图：
 *   graph_id     TEXT NOT NULL PRIMARY KEY
 *   doc_state     BLOB NOT NULL          -- Y.encodeStateAsUpdate() 输出
 *   schema_version INTEGER NOT NULL      -- 写入侧规则版本（当前 1；以后字段语义变了就 bump）
 *   updated_at    TEXT NOT NULL          -- ISO 字符串
 *
 * 写入路径：
 *   Y.Doc 变化 → 防抖 1s → 编码为 Uint8Array → INSERT OR UPDATE
 *
 * 启动路径：
 *   按 graph_id 读最新快照 → Y.applyUpdate() 还原 → 没有快照则走 migrateFromLegacy()
 *   从老 nodes/edges 表回填。
 */

import type BetterSqlite3 from 'better-sqlite3'
import { YjsDocument, type NodeData, type EdgeData } from './yjs-doc'

/** schema_version 当前值；以后字段语义变化再 bump。 */
export const CURRENT_YJS_SCHEMA_VERSION = 1

export interface SnapshotRow {
  graphId: string
  docState: Uint8Array
  schemaVersion: number
  updatedAt: string
}

export interface MigrationResult {
  scannedGraphs: number
  backfilled: number
  skipped: number
  errors: Array<{ graphId: string; error: string }>
}

export class SnapshotStore {
  constructor(private db: BetterSqlite3.Database) {}

  /** 按 graphId 取最新快照；不存在返回 null */
  getLatest(graphId: string): SnapshotRow | null {
    const row = this.db
      .prepare(
        'SELECT graph_id, doc_state, schema_version, updated_at FROM yjs_snapshots WHERE graph_id = ?',
      )
      .get(graphId) as
      | { graph_id: string; doc_state: Buffer; schema_version: number; updated_at: string }
      | undefined
    if (!row) return null
    return {
      graphId: row.graph_id,
      docState: new Uint8Array(row.doc_state),
      schemaVersion: row.schema_version,
      updatedAt: row.updated_at,
    }
  }

  /**
   * 写入或更新一张图的快照。UPSERT 语义，
   * 重复写入同图不会产生 duplicate key 错误。
   */
  save(graphId: string, docState: Uint8Array, schemaVersion: number = CURRENT_YJS_SCHEMA_VERSION): SnapshotRow {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO yjs_snapshots (graph_id, doc_state, schema_version, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(graph_id) DO UPDATE SET
           doc_state = excluded.doc_state,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(graphId, Buffer.from(docState), schemaVersion, now)
    return { graphId, docState, schemaVersion, updatedAt: now }
  }

  delete(graphId: string): void {
    this.db.prepare('DELETE FROM yjs_snapshots WHERE graph_id = ?').run(graphId)
  }

  listGraphIds(): string[] {
    const rows = this.db.prepare('SELECT graph_id FROM yjs_snapshots').all() as Array<{
      graph_id: string
    }>
    return rows.map((r) => r.graph_id)
  }

  /**
   * 把老 nodes/edges 表的内容编码进 Y.Doc 快照 —— 一次性迁移。
   *
   * 设计：
   * - 仅在 graph 没有快照记录时回填（幂等）；
   * - 每个 graph 单独 try/catch，单图失败不让整批失败；
   * - 不会删除老 nodes/edges 行 —— 老表是只读 fallback，保留以兼容老 query。
   */
  migrateFromLegacy(): MigrationResult {
    const result: MigrationResult = {
      scannedGraphs: 0,
      backfilled: 0,
      skipped: 0,
      errors: [],
    }
    const graphRows = this.db.prepare('SELECT id FROM graphs').all() as Array<{ id: string }>

    for (const g of graphRows) {
      result.scannedGraphs += 1
      const graphId = g.id
      try {
        const existing = this.getLatest(graphId)
        if (existing) {
          result.skipped += 1
          continue
        }
        const doc = new YjsDocument()
        const nodeRows = this.db
          .prepare('SELECT * FROM nodes WHERE graph_id = ?')
          .all(graphId) as Array<Record<string, unknown>>
        const edgeRows = this.db
          .prepare('SELECT * FROM edges WHERE graph_id = ?')
          .all(graphId) as Array<Record<string, unknown>>

        doc.transaction(() => {
          for (const row of nodeRows) {
            const id = row.id as string
            doc.setNode(id, rowToNodeData(row))
          }
          for (const row of edgeRows) {
            const id = row.id as string
            doc.setEdge(id, rowToEdgeData(row))
          }
        })

        this.save(graphId, doc.encodeState())
        result.backfilled += 1
      } catch (err) {
        result.errors.push({
          graphId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return result
  }
}

// ============================================================
// 老 SQLite row → Y.Doc 字段映射
// ============================================================

/** 与 NodeRepository.rowToNode 字段对齐；JSON 字段原样传透。 */
function rowToNodeData(row: Record<string, unknown>): NodeData {
  return {
    id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    title: String(row.title),
    description: typeof row.description === 'string' ? row.description : undefined,
    acceptanceCriteria: parseJsonField(row.acceptance_criteria),
    graphId: String(row.graph_id),
    graphType: row.graph_type === 'dev' ? 'dev' : 'online',
    parentId: typeof row.parent_id === 'string' ? row.parent_id : undefined,
    rules: parseJsonField(row.rules),
    metadata: parseJsonField(row.metadata),
    ownerRole: typeof row.owner_role === 'string' ? row.owner_role : undefined,
    position: {
      x: typeof row.position_x === 'number' ? row.position_x : 0,
      y: typeof row.position_y === 'number' ? row.position_y : 0,
    },
    content: parseJsonField(row.content),
    communitySummary: typeof row.community_summary === 'string' ? row.community_summary : undefined,
    communityLevel: typeof row.community_level === 'number' ? row.community_level : undefined,
    communityId: typeof row.community_id === 'string' ? row.community_id : undefined,
    contextRefs: parseJsonField(row.context_refs),
    wikiContent: typeof row.wiki_content === 'string' ? row.wiki_content : undefined,
    wikiMeta: parseJsonField(row.wiki_meta),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToEdgeData(row: Record<string, unknown>): EdgeData {
  return {
    id: String(row.id),
    source: String(row.source),
    target: String(row.target),
    label: typeof row.label === 'string' ? row.label : undefined,
    edgeType: typeof row.edge_type === 'string' ? row.edge_type : undefined,
    graphId: String(row.graph_id),
    description: typeof row.description === 'string' ? row.description : undefined,
    dataFlow: typeof row.data_flow === 'string' ? row.data_flow : undefined,
    strength: typeof row.strength === 'number' ? row.strength : undefined,
    content: parseJsonField(row.content) as EdgeData['content'],
  }
}

function parseJsonField(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}