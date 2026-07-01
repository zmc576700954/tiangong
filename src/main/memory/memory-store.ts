/**
 * 会话记忆存储层
 *
 * 借鉴 claude-mem 的 SessionStore + FTS5 设计
 * 基于 better-sqlite3 实现结构化记忆的持久化、检索和全文搜索
 *
 * 核心数据流:
 *   AgentManager.terminateSession() → MemoryExtractor.extract() → MemoryStore.store()
 *   渲染层 IPC 调用 → MemoryStore.search() / getRecent()
 */

import { getClient } from '../database'
import type BetterSqlite3 from 'better-sqlite3'
import type { MemoryItem, MemoryKind } from '@shared/types'
import { createLogger } from '../shared/logger'
import { safeRowId } from '../shared/db-utils'

const logger = createLogger('MemoryStore')

/** FTS5 虚拟表名 */
const FTS_TABLE = 'memory_fts'

/**
 * FTS 触发器结构版本号：修改触发器逻辑时递增（v1 → v2 → …）。
 *
 * 用 SQLite 内置的 PRAGMA user_version（32 位整数，独立于 database.ts 使用的
 * schema_version 表）持久化当前 DB 已应用的触发器版本。启动时数值比较：
 *   stored < CURRENT_FTS_TRIGGER_VERSION → 重建触发器 + rebuild FTS 索引
 *   stored ≥ CURRENT_FTS_TRIGGER_VERSION → 跳过重建（消除 O(N) 启动开销）
 *
 * 相比历史上"在触发器 SQL 中埋一段注释字符串然后 substring-match"的做法，此方案不受
 * 触发器 SQL 格式化 / 注释挪位 / 其他触发器意外包含相同字符串等影响。
 *
 * ⚠️  修改 memory_fts_ai / _ad / _au 三个触发器时必须递增此常量。
 */
const CURRENT_FTS_TRIGGER_VERSION = 1

export class MemoryStore {
  private db: BetterSqlite3.Database
  /** FTS5 初始化状态：'pending' 表示在尝试中，'ready' 已就绪，'failed' 失败可重试 */
  private ftsState: 'pending' | 'ready' | 'failed' = 'pending'
  /**
   * 缓存的 INSERT 预编译语句，供 store/storeMany/storeManyVersioned 复用。
   * better-sqlite3 的 prepare() 每次调用都分配新对象，缓存可消除每次写入的分配开销。
   * 懒初始化（首次使用时创建），避免在 db 尚未 migrate 完成时预编译。
   */
  private _insertStmt?: BetterSqlite3.Statement

  /**
   * @param db - 可选：注入数据库客户端（测试用），不传则从全局单例获取
   */
  constructor(db?: BetterSqlite3.Database) {
    this.db = db ?? getClient()
    this._initFts()
  }

  /** 触发 FTS 初始化；失败标记 failed，下次操作可重试 */
  private _initFts(): void {
    this.ftsState = 'pending'
    try {
      this._ensureFts()
      this.ftsState = 'ready'
    } catch (err) {
      this.ftsState = 'failed'
      logger.warn('FTS5 setup failed (will retry on next search):', err)
    }
  }

  /** 懒初始化并缓存 INSERT 预编译语句，避免每次 store/storeMany/storeManyVersioned 调用都重新 prepare */
  private _getInsertStmt(): BetterSqlite3.Statement {
    if (!this._insertStmt) {
      this._insertStmt = this.db.prepare(
        `INSERT INTO memory_items
          (session_id, kind, project_id, node_id, title, narrative, facts, concepts,
           files_read, files_modified, adapter_name, token_cost, confidence,
           version, parent_version, embedding, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
    }
    return this._insertStmt
  }

  /**
   * 确保 FTS5 虚拟表和触发器已创建
   * 在现有数据库上升级时需要通过此方法补充创建
   */
  private _ensureFts(): void {
    // 检测 json_each 是否可用（SQLite 3.38+）
    let jsonEachAvailable = false
    try {
      this.db.prepare("SELECT 1 FROM json_each('[\"test\"]') LIMIT 0").get()
      jsonEachAvailable = true
    } catch {
      logger.info('json_each not available, FTS5 will index raw JSON text')
    }

    try {
      this.db.exec(`
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

    // 旧版本曾用不对称的 delete 触发器（INSERT 用 json_each 展开、DELETE 传原始 JSON），
    // 会逐步损坏 FTS 倒排索引。由于 CREATE TRIGGER IF NOT EXISTS 不会替换已存在的旧触发器，
    // 需要先 DROP 再重建为正确版本，并执行 'rebuild' 修复历史损坏。
    //
    // 版本记录：用 PRAGMA user_version（SQLite 内置的 32 位整数元数据字段）持久化
    // 当前 DB 已应用的触发器版本，与 database.ts 的 schema_version 表相互独立、无冲突。
    // 相比历史上"substring-match 触发器 SQL 中的注释标记"的方案，此方式不受触发器 SQL
    // 格式化或其他触发器意外包含相同字符串等影响。
    const storedTriggerVersion = ((): number => {
      try {
        const row = this.db.pragma('user_version', { simple: true })
        return typeof row === 'number' ? row : Number(row) || 0
      } catch {
        return 0
      }
    })()
    const triggersAlreadyFixed = storedTriggerVersion >= CURRENT_FTS_TRIGGER_VERSION

    if (!triggersAlreadyFixed) {
      // 旧版或缺失触发器：DROP 全部后重建，确保三个触发器版本一致
      this.db.exec(`DROP TRIGGER IF EXISTS memory_fts_ai`)
      this.db.exec(`DROP TRIGGER IF EXISTS memory_fts_ad`)
      this.db.exec(`DROP TRIGGER IF EXISTS memory_fts_au`)
    }

    if (jsonEachAvailable) {
      // 使用 json_each() 展开 JSON 数组，提取纯文本值（更好的搜索质量）
      this.db.exec(`
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

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_items
        BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES (
            'delete',
            old.id,
            old.title,
            old.narrative,
            CASE WHEN json_valid(old.facts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(old.facts))
              ELSE old.facts
            END,
            CASE WHEN json_valid(old.concepts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(old.concepts))
              ELSE old.concepts
            END
          );
        END
      `)

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES (
            'delete',
            old.id,
            old.title,
            old.narrative,
            CASE WHEN json_valid(old.facts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(old.facts))
              ELSE old.facts
            END,
            CASE WHEN json_valid(old.concepts)
              THEN (SELECT group_concat(value, ' ') FROM json_each(old.concepts))
              ELSE old.concepts
            END
          );
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
      // 回退：直接索引原始 JSON 文本（SQLite < 3.38，json_each 不可用）
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(rowid, title, narrative, facts, concepts)
          VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
        END
      `)

      // ⚠️  修改此触发器逻辑时须递增 CURRENT_FTS_TRIGGER_VERSION（顶部常量），
      // 否则现有数据库不会检测到差异、不会重建。
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_items
        BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
        END
      `)

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_items BEGIN
          INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, title, narrative, facts, concepts)
          VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
          INSERT INTO ${FTS_TABLE}(rowid, title, narrative, facts, concepts)
          VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
        END
      `)
    }

    // 仅在触发器需要修复时（旧版本升级）才执行全量 FTS rebuild。
    // 已修复的数据库（triggersAlreadyFixed === true）跳过此步，避免每次启动都
    // 对 memory_items 全表做 O(N) 重索引，消除启动热路径上的性能瓶颈。
    if (!triggersAlreadyFixed) {
      try {
        this.db.exec(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES ('rebuild')`)
        logger.info('FTS5 index rebuilt to repair legacy asymmetric-trigger corruption')
      } catch (err) {
        logger.warn('FTS5 index rebuild failed (search may be degraded):', err)
      }
      // 只有触发器 + rebuild 都完成后才推进 user_version，避免中途失败被误判为"已修复"
      try {
        this.db.pragma(`user_version = ${CURRENT_FTS_TRIGGER_VERSION}`)
      } catch (err) {
        logger.warn(`Failed to persist FTS trigger version ${CURRENT_FTS_TRIGGER_VERSION}:`, err)
      }
    }

    logger.info('FTS5 virtual table and triggers initialized')
  }

  /**
   * 查找同项目中概念匹配的已有记忆（用于版本化冲突检测）
   *
   * 遍历 concepts 数组，用 LIKE 匹配 JSON 数组中的元素，
   * 返回置信度最高的匹配项或 null。
   */
  private _findByConcepts(projectId: string, concepts: string[]): MemoryItem[] {
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

    const rows = this.db.prepare(
      `SELECT * FROM memory_items
            WHERE project_id = ? AND (${whereClause})
            ORDER BY confidence DESC
            LIMIT 10`,
    ).all(...args)

    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 获取概念演进链 —— 按 parent_version 链递归查询完整版本序列
   *
   * 返回从最早版本到最新版本的演进序列，按 version ASC 排序。
   */
  getEvolutionChain(concept: string, projectId: string): MemoryItem[] {
    const matches = this._findByConcepts(projectId, [concept])
    if (matches.length === 0) return []

    const chain: MemoryItem[] = []
    const visited = new Set<number>()

    for (const item of matches) {
      if (item.id == null || visited.has(item.id)) continue
      chain.push(item)
      visited.add(item.id)

      let currentParentVersion: number | null | undefined = item.parent_version
      while (currentParentVersion != null && !visited.has(currentParentVersion)) {
        const parent = this.db.prepare('SELECT * FROM memory_items WHERE id = ?')
          .get(currentParentVersion) as Record<string, unknown> | undefined
        if (!parent) break
        const parentItem = this._rowToItem(parent)
        if (parentItem.id != null) visited.add(parentItem.id)
        chain.push(parentItem)
        currentParentVersion = parentItem.parent_version
      }
    }

    return chain.sort((a, b) => (a.version ?? 1) - (b.version ?? 1))
  }

  /**
   * 计算记忆的版本信息（供 store / storeManyVersioned 复用）
   *
   * 规则：
   *   - 无匹配概念 → version=1, parentVersion=null
   *   - 匹配且新置信度更高 → version=existing.version+1, parentVersion=existing.id（真版本链）
   *   - 匹配但新置信度不高于已有 → version=1, parentVersion=existing.id（不同视角，保留可导航链）
   */
  private _computeVersionInfo(item: Omit<MemoryItem, 'id'>): { version: number; parentVersion: number | null } {
    if (item.concepts.length === 0) return { version: 1, parentVersion: null }

    const existingItems = this._findByConcepts(item.project_id, item.concepts)
    if (existingItems.length === 0) return { version: 1, parentVersion: null }

    const existing = existingItems[0] // highest confidence match
    if (existing.confidence < item.confidence) {
      return { version: (existing.version ?? 1) + 1, parentVersion: existing.id! }
    }
    return { version: 1, parentVersion: existing.id! }
  }

  /**
   * FTS 就绪校验：若失败可重试一次，仍未就绪返回 false 让调用方跳过写入。
   * store / storeMany / storeManyVersioned 共享此门控，避免每处独立复制。
   */
  private _ensureFtsReadyOrRetry(operation: string): boolean {
    if (this.ftsState === 'ready') return true
    if (this.ftsState === 'failed') {
      this._initFts()
    }
    if ((this.ftsState as string) !== 'ready') {
      logger.warn(`FTS not ready, skipping ${operation} to avoid unindexed rows`)
      return false
    }
    return true
  }

  /**
   * 执行 memory_items 的 INSERT（供 store / storeMany / storeManyVersioned 复用）
   *
   * 使用缓存的 17 列预编译语句 —— 单一实现点保证列顺序与列数变更时只需修改一处。
   */
  private _executeInsert(
    item: Omit<MemoryItem, 'id'>,
    version: number,
    parentVersion: number | null,
  ): number {
    const info = this._getInsertStmt().run(
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
    )
    return safeRowId(info.lastInsertRowid)
  }

  /**
   * 存储一条记忆（含版本化冲突检测）
   *
   * 版本规则见 _computeVersionInfo。
   * @returns 新记忆的 ID，FTS 未就绪时返回 -1
   */
  store(item: Omit<MemoryItem, 'id'>): number {
    if (!this._ensureFtsReadyOrRetry('store')) return -1
    const { version, parentVersion } = this._computeVersionInfo(item)
    return this._executeInsert(item, version, parentVersion)
  }

  /**
   * 批量存储多条记忆（事务化，不做版本化冲突检测）
   *
   * 使用 better-sqlite3 的事务 API 在单个事务中执行所有 INSERT：
   * - 中途失败整体回滚，FTS 触发器的索引行也一并回滚
   * 失败时抛出，调用方决定是否重试或降级。
   *
   * 每条记忆均以 item.version ?? 1, item.parent_version ?? null 写入。
   * 如需概念级去重/版本化，请改用 storeManyVersioned()。
   */
  storeMany(items: Omit<MemoryItem, 'id'>[]): number[] {
    if (items.length === 0) return []
    if (!this._ensureFtsReadyOrRetry('storeMany')) return []

    const insertMany = this.db.transaction((items: Omit<MemoryItem, 'id'>[]) => {
      const ids: number[] = []
      for (const item of items) {
        ids.push(this._executeInsert(item, item.version ?? 1, item.parent_version ?? null))
      }
      return ids
    })

    return insertMany(items)
  }

  /**
   * 批量存储并应用概念级版本化/去重（事务化）。
   *
   * 与 storeMany 不同：每条记忆在写入前先用 _findByConcepts 查找同项目概念匹配项，
   * 命中时建立 parent_version 链接（高置信度才递增 version）。这避免了反复跑相同任务时
   * 记忆无限重复增长的问题（pipeline 主写入路径应使用此方法而非 storeMany）。
   *
   * 注意：_findByConcepts 在事务内对刚插入的行同样可见（同一连接），因此同一批次内的
   * 重复概念也会被串联，不会各自独立写成 version=1。
   */
  storeManyVersioned(items: Omit<MemoryItem, 'id'>[]): number[] {
    if (items.length === 0) return []
    if (!this._ensureFtsReadyOrRetry('storeManyVersioned')) return []

    const insertMany = this.db.transaction((items: Omit<MemoryItem, 'id'>[]) => {
      const ids: number[] = []
      for (const item of items) {
        const { version, parentVersion } = this._computeVersionInfo(item)
        ids.push(this._executeInsert(item, version, parentVersion))
      }
      return ids
    })

    return insertMany(items)
  }
  search(
    query: string,
    options?: {
      projectId?: string
      kind?: MemoryKind
      limit?: number
    },
  ): MemoryItem[] {
    // FTS 未就绪时降级到 LIKE
    if (this.ftsState !== 'ready') {
      if (this.ftsState === 'failed') {
        this._initFts()
      }
      // 如果重试后仍未就绪，直接走 LIKE 降级路径
    }

    const limit = options?.limit ?? 20

    if (this.ftsState === 'ready') {
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

        const rows = this.db.prepare(
          `SELECT m.* FROM ${FTS_TABLE} f
              JOIN memory_items m ON m.id = f.rowid
              WHERE ${FTS_TABLE} MATCH ? ${whereClause}
              ORDER BY rank
              LIMIT ?`,
        ).all(query, ...args, limit)
        return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
      } catch {
        // FTS5 查询失败时降级到 LIKE
      }
    }

    // LIKE 降级路径
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

    const rows = this.db.prepare(
      `SELECT m.* FROM memory_items m
              WHERE ${whereClause}
              ORDER BY m.created_at DESC
              LIMIT ?`,
    ).all(...args, limit)
    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 获取最近记忆（用于上下文注入）
   */
  getRecent(options?: {
    projectId?: string
    nodeId?: string
    limit?: number
  }): MemoryItem[] {
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

    const rows = this.db.prepare(
      `SELECT * FROM memory_items ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    ).all(...args, limit)
    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 获取关联到指定节点的记忆
   */
  getByNode(nodeId: string, limit = 20): MemoryItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_items WHERE node_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(nodeId, limit)
    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 获取指定会话的所有记忆
   * @param sessionId 会话 ID
   * @param limit 最大返回条数，默认 500（防止单次 IPC 拉取过大）
   */
  getBySession(sessionId: string, limit = 500): MemoryItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM memory_items WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(sessionId, limit)
    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 获取跨适配器的记忆（供 Agent A 复用 Agent B 的发现）
   */
  getCrossAdapter(
    projectId: string,
    excludeAdapter: string,
    limit = 10,
  ): MemoryItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM memory_items
            WHERE project_id = ? AND adapter_name != ?
            ORDER BY created_at DESC LIMIT ?`,
    ).all(projectId, excludeAdapter, limit)
    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 按概念标签查询（用于模式发现）
   */
  getByConcept(concept: string, options?: { projectId?: string; limit?: number }): MemoryItem[] {
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

    const rows = this.db.prepare(
      `SELECT * FROM memory_items WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    ).all(...args, limit)
    return rows.map((r) => this._rowToItem(r as Record<string, unknown>))
  }

  /**
   * 统计记忆（按类型分组）
   */
  getStats(projectId?: string): Array<{ kind: string; count: number }> {
    const sql = projectId
      ? 'SELECT kind, COUNT(*) as count FROM memory_items WHERE project_id = ? GROUP BY kind'
      : 'SELECT kind, COUNT(*) as count FROM memory_items GROUP BY kind'
    const args = projectId ? [projectId] : []
    const rows = this.db.prepare(sql).all(...args)
    return rows.map((r) => ({
      kind: (r as Record<string, unknown>).kind as string,
      count: (r as Record<string, unknown>).count as number,
    }))
  }

  /**
   * 删除指定会话的记忆
   */
  deleteBySession(sessionId: string): number {
    const info = this.db.prepare(
      'DELETE FROM memory_items WHERE session_id = ?',
    ).run(sessionId)
    return info.changes
  }

  /**
   * 删除指定会话的记忆（带 projectId 授权校验）
   *
   * 与 deleteBySession 的差异：必须同时匹配 session_id 与 project_id 才会删除，
   * 防止未授权调用方仅凭 sessionId 删除其他项目的会话记忆。
   * IPC 入口（memory:delete）只暴露此方法。
   */
  deleteBySessionScoped(sessionId: string, projectId: string): number {
    const info = this.db.prepare(
      'DELETE FROM memory_items WHERE session_id = ? AND project_id = ?',
    ).run(sessionId, projectId)
    return info.changes
  }

  /**
   * 清理 N 天前的低置信度记忆
   */
  pruneStale(daysThreshold = 90): number {
    const info = this.db.prepare(
      `DELETE FROM memory_items
            WHERE confidence < 0.5
            AND created_at < datetime('now', '-' || ? || ' days')`,
    ).run(daysThreshold)
    return info.changes
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
  pruneWithDecay(
    projectId: string,
    config?: {
      baseHalfLife?: number   // 基础半衰期（天），默认 30
      minConfidence?: number  // 最低衰减置信度阈值，默认 0.1
      maxItems?: number       // 项目最大记忆条数，默认 5000
    },
  ): number {
    const baseHalfLife = config?.baseHalfLife ?? 30
    const minConfidence = config?.minConfidence ?? 0.1
    const maxItems = config?.maxItems ?? 5000

    // 获取该项目所有非waterline记忆，计算衰减置信度
    // waterline kind 永不参与衰减淘汰
    const rows = this.db.prepare(
      `SELECT id, confidence, created_at, kind FROM memory_items WHERE project_id = ? AND kind != 'waterline'`,
    ).all(projectId) as Record<string, unknown>[]

    if (rows.length === 0) return 0

    const now = Date.now()
    const idsToDelete = new Set<number>()

    // 计算每条记忆的衰减置信度（跳过 created_at 为 null 的记录）
    const itemsWithDecay = rows
      .map((r) => {
        const id = safeRowId(r.id)
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

    // 分批删除：当 idsToDelete 很大（项目记忆远超 maxItems）时，单条 `id IN (?,?,...)`
    // 的占位符数量可能超过 SQLITE_MAX_VARIABLE_NUMBER（默认 32766）而抛错，导致 prune 整体失败、
    // 内存永远无法清理。每批 ≤ 900 个 id（为 project_id 留出余量），整体包在一个事务里保证原子性。
    const idsArray = Array.from(idsToDelete)
    const BATCH_SIZE = 900
    let totalChanges = 0
    const deleteBatches = this.db.transaction((all: number[]) => {
      let changes = 0
      for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const batch = all.slice(i, i + BATCH_SIZE)
        const placeholders = batch.map(() => '?').join(',')
        const info = this.db.prepare(
          `DELETE FROM memory_items WHERE project_id = ? AND id IN (${placeholders})`,
        ).run(projectId, ...batch)
        changes += info.changes
      }
      return changes
    })
    totalChanges = deleteBatches(idsArray)
    return totalChanges
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
   * 注意：此方法仍为 async，因为 embeddingFn 是异步的，
   * 但内部数据库操作均已改为同步调用。
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
    const selectStmt = this.db.prepare(
      `SELECT id, title, narrative, facts FROM memory_items
              WHERE project_id = ? AND embedding IS NULL AND kind != 'waterline'
              AND id > ?
              ORDER BY id ASC LIMIT ?`,
    )
    const updateStmt = this.db.prepare(
      'UPDATE memory_items SET embedding = ? WHERE id = ?',
    )

    while (true) {
      const rows = selectStmt.all(projectId, cursor, batchSize) as Record<string, unknown>[]

      if (rows.length === 0) break

      for (const row of rows) {
        try {
          const title = (row.title as string) ?? ''
          const narrative = (row.narrative as string) ?? ''
          const facts = this._parseJsonArray(row.facts as string).join(' ')
          const text = `${title} ${narrative} ${facts}`
          const embedding = await embeddingFn(text)

          const rowId = safeRowId(row.id)
          updateStmt.run(JSON.stringify(embedding), rowId)
          totalBackfilled++
        } catch (err) {
          logger.warn(`Failed to backfill embedding for memory ${row.id}:`, err)
        }
      }

      // 推进游标到本批次最大 id
      cursor = safeRowId(rows[rows.length - 1].id)
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
