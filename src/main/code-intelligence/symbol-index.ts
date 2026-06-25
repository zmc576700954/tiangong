/**
 * 符号索引管理器
 * 负责存储和查询代码符号、import 依赖关系
 * 使用 @libsql/client 异步 API，复用项目数据库连接
 */

import type { Client } from '@libsql/client'
import type { SymbolInfo, ImportEdge, SymbolQueryResult } from '@shared/types'
import { getClient } from '../database'

export class SymbolIndex {
  private injectedClient?: Client

  constructor(injectedClient?: Client) {
    this.injectedClient = injectedClient
  }

  private db(): Client {
    return this.injectedClient ?? getClient()
  }

  /** 初始化符号索引表 */
  async initTables(): Promise<void> {
    const db = this.db()

    await db.execute(`
      CREATE TABLE IF NOT EXISTS symbols (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        end_line INTEGER,
        end_column INTEGER,
        signature TEXT,
        js_doc TEXT,
        parent_id TEXT,
        is_exported INTEGER NOT NULL DEFAULT 0,
        source_code TEXT
      )
    `)

    await db.execute(`CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbols(name)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_symbol_file ON symbols(file_path)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_symbol_kind ON symbols(kind)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_symbol_parent ON symbols(parent_id)`)

    await db.execute(`
      CREATE TABLE IF NOT EXISTS import_edges (
        from_file TEXT NOT NULL,
        to_file TEXT NOT NULL,
        imported_names TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        line INTEGER NOT NULL,
        PRIMARY KEY (from_file, to_file, line)
      )
    `)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_import_from ON import_edges(from_file)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_import_to ON import_edges(to_file)`)

    await db.execute(`
      CREATE TABLE IF NOT EXISTS symbol_refs (
        symbol_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        is_definition INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol_id, file_path, line, column)
      )
    `)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_ref_symbol ON symbol_refs(symbol_id)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_ref_file ON symbol_refs(file_path)`)
  }

  /** 批量插入符号（在显式事务中用 db.batch() 提交，减少 DB 往返并保证原子性） */
  async insertSymbols(symbols: SymbolInfo[]): Promise<void> {
    if (symbols.length === 0) return
    const db = this.db()
    const sql = `
      INSERT OR REPLACE INTO symbols
      (id, name, kind, file_path, line, column, end_line, end_column, signature, js_doc, parent_id, is_exported, source_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    await this.runInTransaction(db, symbols, 50, (s) => ({
      sql,
      args: [
        s.id, s.name, s.kind, s.filePath, s.line, s.column,
        s.endLine ?? null, s.endColumn ?? null, s.signature ?? null,
        s.jsDoc ?? null, s.parentId ?? null, s.isExported ? 1 : 0,
        s.sourceCode ?? null,
      ] as (string | number | null)[],
    }))
  }

  /** 批量插入 import 边（在显式事务中用 db.batch() 提交，减少 DB 往返并保证原子性） */
  async insertImportEdges(edges: ImportEdge[]): Promise<void> {
    if (edges.length === 0) return
    const db = this.db()
    const sql = `
      INSERT OR REPLACE INTO import_edges
      (from_file, to_file, imported_names, is_default, line)
      VALUES (?, ?, ?, ?, ?)
    `
    await this.runInTransaction(db, edges, 150, (e) => ({
      sql,
      args: [e.fromFile, e.toFile, JSON.stringify(e.importedNames), e.isDefaultImport ? 1 : 0, e.line] as (string | number | null)[],
    }))
  }

  private async runInTransaction<T>(
    db: Client,
    items: T[],
    batchSize: number,
    buildStmt: (item: T) => { sql: string; args: (string | number | null)[] },
  ): Promise<void> {
    const tx = await db.transaction()
    try {
      for (let i = 0; i < items.length; i += batchSize) {
        const chunk = items.slice(i, i + batchSize)
        await tx.batch(chunk.map(buildStmt))
      }
      await tx.commit()
    } catch (err) {
      await tx.rollback().catch(() => {})
      throw err
    } finally {
      if (!tx.closed) {
        tx.close()
      }
    }
  }

  /** 按名称精确或模糊查询符号 */
  async querySymbols(
    name: string,
    options?: { kind?: SymbolInfo['kind']; limit?: number; fuzzy?: boolean }
  ): Promise<SymbolQueryResult[]> {
    const db = this.db()
    const limit = options?.limit ?? 20

    if (options?.fuzzy) {
      const result = await db.execute({
        sql: `SELECT * FROM symbols WHERE name LIKE ? ${options.kind ? 'AND kind = ?' : ''} ORDER BY LENGTH(name) ASC LIMIT ?`,
        args: options.kind ? [`%${name}%`, options.kind, limit] : [`%${name}%`, limit],
      })
      return result.rows.map((r) => ({
        symbol: this.rowToSymbol(r as unknown as Record<string, unknown>),
        score: 0.7,
        matchedBy: 'fuzzy' as const,
      }))
    }

    const result = await db.execute({
      sql: `SELECT * FROM symbols WHERE name = ? ${options?.kind ? 'AND kind = ?' : ''} ORDER BY line ASC LIMIT ?`,
      args: options?.kind ? [name, options.kind, limit] : [name, limit],
    })
    return result.rows.map((r) => ({
      symbol: this.rowToSymbol(r as unknown as Record<string, unknown>),
      score: 1.0,
      matchedBy: 'exact' as const,
    }))
  }

  /** 查询文件中的所有符号 */
  async getSymbolsByFile(filePath: string): Promise<SymbolInfo[]> {
    const db = this.db()
    const result = await db.execute({
      sql: 'SELECT * FROM symbols WHERE file_path = ? ORDER BY line ASC',
      args: [filePath],
    })
    return result.rows.map((r) => this.rowToSymbol(r as unknown as Record<string, unknown>))
  }

  /** 查询一个文件 import 了哪些文件 */
  async getImports(filePath: string): Promise<ImportEdge[]> {
    const db = this.db()
    const result = await db.execute({
      sql: 'SELECT * FROM import_edges WHERE from_file = ?',
      args: [filePath],
    })
    return result.rows.map((r) => this.rowToImportEdge(r as unknown as Record<string, unknown>))
  }

  /** 查询哪些文件 import 了某个文件 */
  async getImporters(filePath: string): Promise<ImportEdge[]> {
    const db = this.db()
    const result = await db.execute({
      sql: 'SELECT * FROM import_edges WHERE to_file = ?',
      args: [filePath],
    })
    return result.rows.map((r) => this.rowToImportEdge(r as unknown as Record<string, unknown>))
  }

  /** 沿依赖图向外扩展 N 层，找到所有相关文件 */
  async getRelatedFiles(filePath: string, depth: number = 2): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    const visited = new Set<string>()
    // 按层处理，每层把当前 frontier 的所有文件一次性批量查询
    let frontier = new Set<string>([filePath])
    let currentDepth = 0

    while (frontier.size > 0 && currentDepth < depth) {
      const nextFrontier = new Set<string>()
      const db = this.db()
      const paths = [...frontier]

      // SQLite 变量上限约 999；这里是 from/to 两组占位符，故每批控制在 400 条以内
      const CHUNK_SIZE = 400
      for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
        const chunk = paths.slice(i, i + CHUNK_SIZE)
        const placeholders = chunk.map(() => '?').join(', ')

        const edgesResult = await db.execute({
          sql: `
            SELECT from_file as p FROM import_edges WHERE to_file IN (${placeholders})
            UNION
            SELECT to_file as p FROM import_edges WHERE from_file IN (${placeholders})
          `,
          args: [...chunk, ...chunk],
        })

        for (const row of edgesResult.rows) {
          const p = (row as unknown as Record<string, unknown>).p as string
          if (!visited.has(p) && p !== filePath) {
            visited.add(p)
            result.set(p, currentDepth + 1)
            nextFrontier.add(p)
          }
        }
      }

      frontier = nextFrontier
      currentDepth++
    }

    return result
  }

  /** 清除某个文件的所有符号和 import 关系 */
  async clearFile(filePath: string): Promise<void> {
    const db = this.db()
    await db.execute({ sql: 'DELETE FROM symbols WHERE file_path = ?', args: [filePath] })
    await db.execute({ sql: 'DELETE FROM import_edges WHERE from_file = ? OR to_file = ?', args: [filePath, filePath] })
    await db.execute({ sql: 'DELETE FROM symbol_refs WHERE file_path = ?', args: [filePath] })
  }

  /** 清除所有数据 */
  async clearAll(): Promise<void> {
    const db = this.db()
    await db.execute('DELETE FROM symbols')
    await db.execute('DELETE FROM import_edges')
    await db.execute('DELETE FROM symbol_refs')
  }

  private rowToSymbol(row: Record<string, unknown>): SymbolInfo {
    return {
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind) as SymbolInfo['kind'],
      filePath: String(row.file_path),
      line: Number(row.line),
      column: Number(row.column),
      endLine: row.end_line != null ? Number(row.end_line) : undefined,
      endColumn: row.end_column != null ? Number(row.end_column) : undefined,
      signature: row.signature != null ? String(row.signature) : undefined,
      jsDoc: row.js_doc != null ? String(row.js_doc) : undefined,
      parentId: row.parent_id != null ? String(row.parent_id) : undefined,
      isExported: Boolean(row.is_exported),
      sourceCode: row.source_code != null ? String(row.source_code) : undefined,
    }
  }

  private rowToImportEdge(row: Record<string, unknown>): ImportEdge {
    return {
      fromFile: String(row.from_file),
      toFile: String(row.to_file),
      importedNames: JSON.parse(String(row.imported_names)),
      isDefaultImport: Boolean(row.is_default),
      line: Number(row.line),
    }
  }
}
