/**
 * 会话记忆存储层
 *
 * 借鉴 claude-mem 的 SessionStore + FTS5 设计
 * 基于 LibSQL 实现结构化记忆的持久化、检索和全文搜索
 *
 * 核心数据流:
 *   AgentManager.terminateSession() → MemoryExtractor.extract() → MemoryStore.store()
 *   渲染层 IPC 调用 → MemoryStore.search() / getRecent()
 */

import { getClient } from '../database'
import type { Client } from '@libsql/client'
import type { MemoryItem, MemoryKind } from '@shared/types'
import { createLogger } from '../shared/logger'
import { safeRowId } from '../shared/db-utils'

const logger = createLogger('MemoryStore')

/** FTS5 虚拟表名 */
const FTS_TABLE = 'memory_fts'

export class MemoryStore {
  private db: Client
  /** FTS5 初始化状态：'pending' 表示在尝试中，'ready' 已就绪，'failed' 失败可重试 */
  private ftsState: 'pending' | 'ready' | 'failed' = 'pending'
  private ftsInitPromise: Promise<void> | null = null

  /**
   * @param db - 可选：注入数据库客户端（测试用），不传则从全局单例获取
   */
  constructor(db?: Client) {
    this.db = db ?? getClient()
    this._initFts()
  }

  /** 触发 FTS 初始化；失败标记 failed，下次 ensureFtsReady() 可重试 */
  private _initFts(): void {
    this.ftsState = 'pending'
    this.ftsInitPromise = this._ensureFts()
      .then(() => { this.ftsState = 'ready' })
      .catch((err) => {
        this.ftsState = 'failed'
        logger.warn('FTS5 setup failed (will retry on next search):', err)
      })
  }

  /** 等待 FTS 就绪；如果之前失败则重试一次 */
  private async ensureFtsReady(): Promise<void> {
    if (this.ftsState === 'ready') return
    if (this.ftsState === 'failed') {
      this._initFts()
    }
    if (this.ftsInitPromise) await this.ftsInitPromise
  }

  /**
   * 确保 FTS5 虚拟表和触发器已创建
   * 在现有数据库上升级时需要通过此方法补充创建
   */
  private async _ensureFts(): Promise<void> {
    // 检测 json_each 是否可用（SQLite 3.38+ / LibSQL）
    let jsonEachAvailable = false
    try {
      await this.db.execute("SELECT 1 FROM json_each('[\"test\"]') LIMIT 0")
      jsonEachAvailable = true
    } catch {
      logger.info('json_each not available, FTS5 will index raw JSON text')
    }

    try {
      await this.db.execute(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE}
        USING fts5(
          title, narrative, facts, concepts,
          content='memory_items', content_rowid='id'
        )
      `)
    } catch {
      // FTS5 不可用时降级
      logger.info('FTS5 not available, falling back to LIKE search')
      return
    }

    if (jsonEachAvailable) {
      // 使用 json_each() 展开 JSON 数组，提取纯文本值（更好的搜索质量）
      await this.db.execute(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(rowid, title, narrative, facts, concepts)
          VALUES (
            new.id,
            new.title,
            new.narrative,
            CASE WHEN json_valid(new.facts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(new.facts))
              ELSE new.facts
            END,
            CASE WHEN json_valid(new.concepts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(new.concepts))
              ELSE new.concepts
            END
          );
        END
      `)

      await this.db.execute(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
        END
      `)

      await this.db.execute(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
          INSERT INTO ${FTS_TABLE}(rowid, title, narrative, facts, concepts)
          VALUES (
            new.id,
            new.title,
            new.narrative,
            CASE WHEN json_valid(new.facts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(new.facts))
              ELSE new.facts
            END,
            CASE WHEN json_valid(new.concepts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(new.concepts))
              ELSE new.concepts
            END
          );
        END
      `)
    } else {
      // 回退：直接索引原始 JSON 文本
      await this.db.execute(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(rowid, title, narrative, facts, concepts)
          VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
        END
      `)

      await this.db.execute(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
        END
      `)

      await this.db.execute(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
          INSERT INTO ${FTS_TABLE}(rowid, title, narrative, facts, concepts)
          VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
        END
      `)
    }

    logger.info('FTS5 virtual table and triggers initialized')
  }

  /**
   * 查找同项目中概念匹配的已有记忆（用于版本化冲突检测）
   *
   * 遍历 concepts 数组，用 LIKE 匹配 JSON 数组中的元素，
   * 返回置信度最高的匹配项或 null。
   */
  private async _findByConcepts(projectId: string, concepts: string[]): Promise<MemoryItem[]> {
    if (concepts.length === 0) return []

    const conditions: string[] = []
    const args: (string | number)[] = [projectId]

    for (const concept of concepts) {
      const escapedConcept = concept
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .replace(/"/g, '\\"')
      conditions.push('concepts LIKE ? ESCAPE \'\\\'')
      args.push(`%"${escapedConcept}"%`)
    }

    const whereClause = conditions.join(' OR ')

    const rows = await this.db.execute({
      sql: `SELECT * FROM memory_items
            WHERE project_id = ? AND (${whereClause})
            ORDER BY confidence DESC
            LIMIT 10`,
      args,
    })

    return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
  }

  /**
   * 获取概念演进链 —— 按 parent_version 链递归查询完整版本序列
   *
   * 返回从最早版本到最新版本的演进序列，按 version ASC 排序。
   */
  async getEvolutionChain(concept: string, projectId: string): Promise<MemoryItem[]> {
    const matches = await this._findByConcepts(projectId, [concept])
    if (matches.length === 0) return []

    const chain: MemoryItem[] = []
    const visited = new Set<number>()

    for (const item of matches) {
      if (item.id == null || visited.has(item.id)) continue
      chain.push(item)
      visited.add(item.id)

      let currentParentVersion: number | null | undefined = item.parent_version
      while (currentParentVersion != null && !visited.has(currentParentVersion)) {
        const parentRows = await this.db.execute({
          sql: 'SELECT * FROM memory_items WHERE id = ?',
          args: [currentParentVersion],
        })
        if (parentRows.rows.length === 0) break
        const parent = this._rowToItem(parentRows.rows[0] as unknown as Record<string, unknown>)
        if (parent.id != null) visited.add(parent.id)
        chain.push(parent)
        currentParentVersion = parent.parent_version
      }
    }

    return chain.sort((a, b) => (a.version ?? 1) - (b.version ?? 1))
  }

  /**
   * 存储一条记忆（含版本化冲突检测）
   *
   * 版本规则:
   *   - 无匹配概念 → version=1, parent_version=null
   *   - 匹配且新置信度更高 → version=existing.version+1, parent_version=existing.id
   *   - 匹配但新置信度不高于已有 → version=1, parent_version=existing.id（不同视角）
   * @returns 新记忆的 ID
   */
  async store(item: Omit<MemoryItem, 'id'>): Promise<number> {
    // 等待 FTS 就绪：trigger 未建时插入会让该行无法被全文检索命中
    await this.ensureFtsReady()

    // 版本化：查找同项目中概念匹配的已有记忆（双版本保留）
    // 两者都保留，不再覆盖低置信度版本
    let version = 1
    let parentVersion: number | null = null

    if (item.concepts.length > 0) {
      const existingItems = await this._findByConcepts(item.project_id, item.concepts)
      if (existingItems.length > 0) {
        const existing = existingItems[0] // highest confidence match
        parentVersion = existing.id!
        if (existing.confidence < item.confidence) {
          version = (existing.version ?? 1) + 1
        }
        // else: version stays 1, parentVersion links to existing (different perspective)
        // Both versions are retained for retrieval choice
      }
    }

    const result = await this.db.execute({
      sql: `INSERT INTO memory_items
        (session_id, kind, project_id, node_id, title, narrative, facts, concepts,
         files_read, files_modified, adapter_name, token_cost, confidence,
         version, parent_version, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        item.session_id,
        item.kind,
        item.project_id,
        item.node_id ?? null,
        item.title,
        item.narrative,
        JSON.stringify(item.facts),
        JSON.stringify(item.concepts),
        JSON.stringify(item.files_read),
        JSON.stringify(item.files_modified),
        item.adapter_name,
        item.token_cost,
        item.confidence,
        version,
        parentVersion,
        item.embedding ? JSON.stringify(item.embedding) : null,
        item.created_at,
      ],
    })
    return safeRowId(result.lastInsertRowid)
  }

  /**
   * 批量存储多条记忆（事务化）
   *
   * 使用 LibSQL 的 batch() API 在单个事务中执行所有 INSERT：
   * - 中途失败整体回滚，FTS 触发器的索引行也一并回滚
   * - 兼容 :memory: 数据库（不依赖 transaction('write') 的连接独占）
   * 失败时抛出，调用方决定是否重试或降级。
   *
   * 注意：批量插入不执行版本化冲突检测（_findByConcepts），
   * 每条记忆均以 version=1, parent_version=null 写入。
   * 如需版本化，请逐条调用 store()。
   */
  async storeMany(items: Omit<MemoryItem, 'id'>[]): Promise<number[]> {
    if (items.length === 0) return []

    // 等待 FTS 就绪：构造函数中的 _initFts 可能未完成，提前插入会绕过
    // memory_fts_ai 触发器，导致这些行永远不进入 FTS 索引。
    await this.ensureFtsReady()

    const statements = items.map((item) => ({
      sql: `INSERT INTO memory_items
        (session_id, kind, project_id, node_id, title, narrative, facts, concepts,
         files_read, files_modified, adapter_name, token_cost, confidence,
         version, parent_version, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        item.session_id,
        item.kind,
        item.project_id,
        item.node_id ?? null,
        item.title,
        item.narrative,
        JSON.stringify(item.facts),
        JSON.stringify(item.concepts),
        JSON.stringify(item.files_read),
        JSON.stringify(item.files_modified),
        item.adapter_name,
        item.token_cost,
        item.confidence,
        item.version ?? 1,
        item.parent_version ?? null,
        item.embedding ? JSON.stringify(item.embedding) : null,
        item.created_at,
      ] as (string | number | null)[],
    }))

    // batch 默认在 "deferred" 事务模式下执行；任一语句失败整批回滚
    const results = await this.db.batch(statements, 'deferred')
    return results.map((r) => safeRowId(r.lastInsertRowid))
  }

  /**
   * FTS5 全文搜索（降级到 LIKE）
   */
  async search(
    query: string,
    options?: {
      projectId?: string
      kind?: MemoryKind
      limit?: number
    },
  ): Promise<MemoryItem[]> {
    // 确保 FTS 已就绪（首次启动期/初始化失败后会自动重试一次）
    await this.ensureFtsReady()
    const limit = options?.limit ?? 20
    try {
      const conditions: string[] = []
      const args: (string | number)[] = []

      if (options?.projectId) {
        conditions.push('m.project_id = ?')
        args.push(options.projectId)
      }
      if (options?.kind) {
        conditions.push('m.kind = ?')
        args.push(options.kind)
      }

      const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''

      const rows = await this.db.execute({
        sql: `SELECT m.* FROM ${FTS_TABLE} f
              JOIN memory_items m ON m.id = f.rowid
              WHERE ${FTS_TABLE} MATCH ? ${whereClause}
              ORDER BY rank
              LIMIT ?`,
        args: [query, ...args, limit],
      })
      return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
    } catch {
      // FTS5 不可用时降级到 LIKE
      // Split multi-word query into individual terms and OR them,
      // so that "auth bug" matches items containing either "auth" or "bug"
      // All LIKE patterns use parameterized ? placeholders to prevent SQL injection.
      const terms = query.split(/\s+/).filter(t => t.length > 0)
      const LIKE_FIELDS = ['m.title', 'm.narrative', 'm.facts', 'm.concepts'] as const
      const conditions: string[] = []
      const args: (string | number)[] = []
      for (const t of terms) {
        const pattern = `%${t}%`
        conditions.push(`(${LIKE_FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
        for (const _ of LIKE_FIELDS) {
          args.push(pattern)
        }
      }

      if (options?.projectId) {
        conditions.push('m.project_id = ?')
        args.push(options.projectId)
      }
      if (options?.kind) {
        conditions.push('m.kind = ?')
        args.push(options.kind)
      }

      // The term conditions (one per search term) are ORed together,
      // then ANDed with any projectId/kind filters.
      const termCount = terms.length
      const termConditions = conditions.slice(0, termCount).join(' OR ')
      const filterConditions = conditions.slice(termCount)
      const whereClause = filterConditions.length > 0
        ? `(${termConditions}) AND ${filterConditions.join(' AND ')}`
        : termConditions

      const rows = await this.db.execute({
        sql: `SELECT m.* FROM memory_items m
              WHERE ${whereClause}
              ORDER BY m.created_at DESC
              LIMIT ?`,
        args: [...args, limit],
      })
      return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
    }
  }

  /**
   * 获取最近记忆（用于上下文注入）
   */
  async getRecent(options?: {
    projectId?: string
    nodeId?: string
    limit?: number
  }): Promise<MemoryItem[]> {
    const limit = options?.limit ?? 10
    const conditions: string[] = []
    const args: (string | number)[] = []

    if (options?.projectId) {
      conditions.push('project_id = ?')
      args.push(options.projectId)
    }
    if (options?.nodeId) {
      conditions.push('node_id = ?')
      args.push(options.nodeId)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await this.db.execute({
      sql: `SELECT * FROM memory_items ${whereClause} ORDER BY created_at DESC LIMIT ?`,
      args: [...args, limit],
    })
    return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
  }

  /**
   * 获取关联到指定节点的记忆
   */
  async getByNode(nodeId: string, limit = 20): Promise<MemoryItem[]> {
    const rows = await this.db.execute({
      sql: 'SELECT * FROM memory_items WHERE node_id = ? ORDER BY created_at DESC LIMIT ?',
      args: [nodeId, limit],
    })
    return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
  }

  /**
   * 获取指定会话的所有记忆
   * @param sessionId 会话 ID
   * @param limit 最大返回条数，默认 500（防止单次 IPC 拉取过大）
   */
  async getBySession(sessionId: string, limit = 500): Promise<MemoryItem[]> {
    const rows = await this.db.execute({
      sql: 'SELECT * FROM memory_items WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      args: [sessionId, limit],
    })
    return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
  }

  /**
   * 获取跨适配器的记忆（供 Agent A 复用 Agent B 的发现）
   */
  async getCrossAdapter(
    projectId: string,
    excludeAdapter: string,
    limit = 10,
  ): Promise<MemoryItem[]> {
    const rows = await this.db.execute({
      sql: `SELECT * FROM memory_items
            WHERE project_id = ? AND adapter_name != ?
            ORDER BY created_at DESC LIMIT ?`,
      args: [projectId, excludeAdapter, limit],
    })
    return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
  }

  /**
   * 按概念标签查询（用于模式发现）
   */
  async getByConcept(concept: string, options?: { projectId?: string; limit?: number }): Promise<MemoryItem[]> {
    const limit = options?.limit ?? 20
    // LIKE 转义：concept 可能包含 % _ \ "，未转义会被当作通配符或破坏 JSON 引号匹配。
    // 用 \ 作为 escape 字符并在 LIKE 子句中声明 ESCAPE '\'。
    const escapedConcept = concept
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_')
      .replace(/"/g, '\\"')
    const conditions: string[] = ['concepts LIKE ? ESCAPE \'\\\'']
    const args: (string | number)[] = [`%"${escapedConcept}"%`]

    if (options?.projectId) {
      conditions.push('project_id = ?')
      args.push(options.projectId)
    }

    const rows = await this.db.execute({
      sql: `SELECT * FROM memory_items WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      args: [...args, limit],
    })
    return rows.rows.map((r) => this._rowToItem(r as unknown as Record<string, unknown>))
  }

  /**
   * 统计记忆（按类型分组）
   */
  async getStats(projectId?: string): Promise<Array<{ kind: string; count: number }>> {
    const sql = projectId
      ? 'SELECT kind, COUNT(*) as count FROM memory_items WHERE project_id = ? GROUP BY kind'
      : 'SELECT kind, COUNT(*) as count FROM memory_items GROUP BY kind'
    const args = projectId ? [projectId] : []
    const rows = await this.db.execute({ sql, args })
    return rows.rows.map((r) => ({
      kind: r.kind as string,
      count: r.count as number,
    }))
  }

  /**
   * 删除指定会话的记忆
   */
  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.db.execute({
      sql: 'DELETE FROM memory_items WHERE session_id = ?',
      args: [sessionId],
    })
    return result.rowsAffected
  }

  /**
   * 删除指定会话的记忆（带 projectId 授权校验）
   *
   * 与 deleteBySession 的差异：必须同时匹配 session_id 与 project_id 才会删除，
   * 防止未授权调用方仅凭 sessionId 删除其他项目的会话记忆。
   * IPC 入口（memory:delete）只暴露此方法。
   */
  async deleteBySessionScoped(sessionId: string, projectId: string): Promise<number> {
    const result = await this.db.execute({
      sql: 'DELETE FROM memory_items WHERE session_id = ? AND project_id = ?',
      args: [sessionId, projectId],
    })
    return result.rowsAffected
  }

  /**
   * 清理 N 天前的低置信度记忆
   */
  async pruneStale(daysThreshold = 90): Promise<number> {
    const result = await this.db.execute({
      sql: `DELETE FROM memory_items
            WHERE confidence < 0.5
            AND created_at < datetime('now', '-' || ? || ' days')`,
      args: [daysThreshold],
    })
    return result.rowsAffected
  }

  /**
   * 基于衰减函数的智能记忆修剪
   *
   * 衰减公式: decayedConfidence = confidence * 0.5^(age/halfLife)
   * 其中 halfLife = baseHalfLife * (1 + confidence)，高置信度记忆衰减更慢
   *
   * 删除策略:
   *   1. 删除 decayedConfidence < minConfidence 的记忆
   *   2. 如果总数仍超过 maxItems，继续删除 decayedConfidence 最低的项
   *
   * @returns 删除的记忆条数
   */
  async pruneWithDecay(
    projectId: string,
    config?: {
      baseHalfLife?: number   // 基础半衰期（天），默认 30
      minConfidence?: number  // 最低衰减置信度阈值，默认 0.1
      maxItems?: number       // 项目最大记忆条数，默认 5000
    },
  ): Promise<number> {
    const baseHalfLife = config?.baseHalfLife ?? 30
    const minConfidence = config?.minConfidence ?? 0.1
    const maxItems = config?.maxItems ?? 5000

    // 获取该项目所有非waterline记忆，计算衰减置信度
    // waterline kind 永不参与衰减淘汰
    const rows = await this.db.execute({
      sql: `SELECT id, confidence, created_at, kind FROM memory_items WHERE project_id = ? AND kind != 'waterline'`,
      args: [projectId],
    })

    if (rows.rows.length === 0) return 0

    const now = Date.now()
    const idsToDelete = new Set<number>()

    // 计算每条记忆的衰减置信度（跳过 created_at 为 null 的记录）
    const itemsWithDecay = rows.rows
      .map((r) => {
        const id = r.id as number
        const confidence = (r.confidence as number) ?? 0.0
        const createdAtStr = r.created_at as string | null
        if (!createdAtStr) {
          // created_at 为 null/undefined，跳过不参与衰减
          return null
        }
        const createdAt = new Date(createdAtStr).getTime()
        if (!Number.isFinite(createdAt)) {
          return null
        }
        const ageInDays = Math.max(0, (now - createdAt) / (1000 * 60 * 60 * 24))
        const halfLife = baseHalfLife * (1 + confidence)
        const decayedConfidence = confidence * Math.pow(0.5, ageInDays / halfLife)
        return { id, confidence, decayedConfidence }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    // 阶段1: 删除衰减置信度低于阈值的项
    for (const item of itemsWithDecay) {
      if (item.decayedConfidence < minConfidence) {
        idsToDelete.add(item.id)
      }
    }

    // 阶段2: 如果剩余项仍超过 maxItems，删除衰减置信度最低的项
    const remaining = itemsWithDecay.filter((item) => !idsToDelete.has(item.id))
    if (remaining.length > maxItems) {
      // 按衰减置信度升序排列，删除最低的
      remaining.sort((a, b) => a.decayedConfidence - b.decayedConfidence)
      const excess = remaining.length - maxItems
      for (let i = 0; i < excess; i++) {
        idsToDelete.add(remaining[i].id)
      }
    }

    if (idsToDelete.size === 0) return 0

    // 批量删除
    const idsArray = Array.from(idsToDelete)
    const placeholders = idsArray.map(() => '?').join(',')
    const result = await this.db.execute({
      sql: `DELETE FROM memory_items WHERE project_id = ? AND id IN (${placeholders})`,
      args: [projectId, ...idsArray],
    })
    return result.rowsAffected
  }

  /**
   * 生成一行紧凑摘要 —— 用于渐进式披露 L1 层
   */
  toCompactSummary(item: MemoryItem): string {
    const icons: Record<MemoryKind, string> = {
      investigation: '\u{1F50D}',
      fix: '\u{1F527}',
      review_finding: '⚠️',
      decision: '⚖️',
      pattern: '\u{1F517}',
      lesson: '\u{1F4A1}',
      waterline: '🌊',
    }
    const icon = icons[item.kind] ?? '●'
    return `${item.id} ${icon} ${item.title}`
  }

  /**
   * 将数据库行转换为 MemoryItem 对象
   */
  private _rowToItem(row: Record<string, unknown>): MemoryItem {
    return {
      id: safeRowId(row.id),
      session_id: row.session_id as string,
      kind: row.kind as MemoryKind,
      project_id: (row.project_id as string) ?? '',
      node_id: (row.node_id as string) ?? null,
      title: row.title as string,
      narrative: (row.narrative as string) ?? '',
      facts: this._parseJsonArray(row.facts as string),
      concepts: this._parseJsonArray(row.concepts as string),
      files_read: this._parseJsonArray(row.files_read as string),
      files_modified: this._parseJsonArray(row.files_modified as string),
      adapter_name: (row.adapter_name as string) ?? '',
      token_cost: (row.token_cost as number) ?? 0,
      confidence: (row.confidence as number) ?? 0.0,
      created_at: row.created_at as string,
      version: (row.version as number) ?? 1,
      parent_version: (row.parent_version as number) ?? null,
      embedding: row.embedding ? (() => { try { return JSON.parse(row.embedding as string) } catch { return null } })() : null,
    }
  }

  private _parseJsonArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * 回填旧记忆条目的 embedding 向量
   *
   * 对 memory_items 中 embedding IS NULL 的条目批量生成向量并更新。
   * 仅处理非 waterline 类型。
   *
   * @returns 回填的记忆条数
   */
  async backfillEmbeddings(
    projectId: string,
    embeddingFn: (text: string) => Promise<number[]>,
    batchSize = 50,
  ): Promise<number> {
    let totalBackfilled = 0

    // 游标分页：每次取 id > cursor 的批次，避免 OFFSET 在并发写入时跳行/重复
    let cursor = 0
    while (true) {
      const rows = await this.db.execute({
        sql: `SELECT id, title, narrative, facts FROM memory_items
              WHERE project_id = ? AND embedding IS NULL AND kind != 'waterline'
              AND id > ?
              ORDER BY id ASC LIMIT ?`,
        args: [projectId, cursor, batchSize],
      })

      if (rows.rows.length === 0) break

      for (const row of rows.rows) {
        try {
          const title = (row.title as string) ?? ''
          const narrative = (row.narrative as string) ?? ''
          const facts = this._parseJsonArray(row.facts as string).join(' ')
          const text = `${title} ${narrative} ${facts}`
          const embedding = await embeddingFn(text)

          await this.db.execute({
            sql: 'UPDATE memory_items SET embedding = ? WHERE id = ?',
            args: [JSON.stringify(embedding), row.id as number],
          })
          totalBackfilled++
        } catch (err) {
          logger.warn(`Failed to backfill embedding for memory ${row.id}:`, err)
        }
      }

      // 推进游标到本批次最大 id
      cursor = rows.rows[rows.rows.length - 1].id as number
    }

    logger.info(`Backfilled ${totalBackfilled} embeddings for project ${projectId}`)
    return totalBackfilled
  }
}

/** 全局单例（懒初始化） */
let _instance: MemoryStore | null = null

export function getMemoryStore(): MemoryStore {
  if (!_instance) {
    _instance = new MemoryStore()
  }
  return _instance
}

/** 测试用：替换全局实例 */
export function setMemoryStoreForTesting(store: MemoryStore): void {
  _instance = store
}
