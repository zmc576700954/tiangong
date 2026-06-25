/**
 * 符号索引管理器
 * 负责存储和查询代码符号、import 依赖关系
 * 使用 better-sqlite3 同步 API，复用项目数据库连接
 */

import type BetterSqlite3 from 'better-sqlite3'
import type { SymbolInfo, ImportEdge, SymbolQueryResult } from '@shared/types'
import { getClient } from '../database'

const SYMBOLS_SQL = `
  INSERT OR REPLACE INTO symbols
  (id, name, kind, file_path, line, column, end_line, end_column, signature, js_doc, parent_id, is_exported, source_code)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

const IMPORT_EDGES_SQL = `
  INSERT OR REPLACE INTO import_edges
  (from_file, to_file, imported_names, is_default, line)
  VALUES (?, ?, ?, ?, ?)
`

export class SymbolIndex {
  private injectedClient?: BetterSqlite3.Database

  constructor(injectedClient?: BetterSqlite3.Database) {
    this.injectedClient = injectedClient
  }

  private db(): BetterSqlite3.Database {
    return this.injectedClient ?? getClient()
  }

  /** 初始化符号索引表 */
  initTables(): void {
    const db = this.db()

    db.exec(`
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

    db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbols(name)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_file ON symbols(file_path)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_kind ON symbols(kind)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_symbol_parent ON symbols(parent_id)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS import_edges (
        from_file TEXT NOT NULL,
        to_file TEXT NOT NULL,
        imported_names TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        line INTEGER NOT NULL,
        PRIMARY KEY (from_file, to_file, line)
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_import_from ON import_edges(from_file)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_import_to ON import_edges(to_file)`)

    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_refs (
        symbol_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        is_definition INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol_id, file_path, line, column)
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ref_symbol ON symbol_refs(symbol_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ref_file ON symbol_refs(file_path)`)
  }

  /** 批量插入符号（在显式事务中提交，减少 DB 往返并保证原子性） */
  insertSymbols(symbols: SymbolInfo[]): void {
    if (symbols.length === 0) return
    const db = this.db()
    const stmt = db.prepare(SYMBOLS_SQL)
    const batchSize = 50
    db.transaction(() => {
      for (let i = 0; i < symbols.length; i += batchSize) {
        const chunk = symbols.slice(i, i + batchSize)
        for (const s of chunk) {
          stmt.run(
            s.id, s.name, s.kind, s.filePath, s.line, s.column,
            s.endLine ?? null, s.endColumn ?? null, s.signature ?? null,
            s.jsDoc ?? null, s.parentId ?? null, s.isExported ? 1 : 0,
            s.sourceCode ?? null,
          )
        }
      }
    })()
  }

  /** 批量插入 import 边（在显式事务中提交，减少 DB 往返并保证原子性） */
  insertImportEdges(edges: ImportEdge[]): void {
    if (edges.length === 0) return
    const db = this.db()
    const stmt = db.prepare(IMPORT_EDGES_SQL)
    const batchSize = 150
    db.transaction(() => {
      for (let i = 0; i < edges.length; i += batchSize) {
        const chunk = edges.slice(i, i + batchSize)
        for (const e of chunk) {
          stmt.run(
            e.fromFile, e.toFile, JSON.stringify(e.importedNames), e.isDefaultImport ? 1 : 0, e.line,
          )
        }
      }
    })()
  }

  /** 按名称精确或模糊查询符号 */
  querySymbols(
    name: string,
    options?: { kind?: SymbolInfo['kind']; limit?: number; fuzzy?: boolean }
  ): SymbolQueryResult[] {
    const db = this.db()
    const limit = options?.limit ?? 20

    if (options?.fuzzy) {
      const rows = options.kind
        ? db.prepare('SELECT * FROM symbols WHERE name LIKE ? AND kind = ? ORDER BY LENGTH(name) ASC LIMIT ?').all(`%${name}%`, options.kind, limit)
        : db.prepare('SELECT * FROM symbols WHERE name LIKE ? ORDER BY LENGTH(name) ASC LIMIT ?').all(`%${name}%`, limit)
      return rows.map((r) => ({
        symbol: this.rowToSymbol(r as unknown as Record<string, unknown>),
        score: 0.7,
        matchedBy: 'fuzzy' as const,
      }))
    }

    const rows = options?.kind
      ? db.prepare('SELECT * FROM symbols WHERE name = ? AND kind = ? ORDER BY line ASC LIMIT ?').all(name, options.kind, limit)
      : db.prepare('SELECT * FROM symbols WHERE name = ? ORDER BY line ASC LIMIT ?').all(name, limit)
    return rows.map((r) => ({
      symbol: this.rowToSymbol(r as unknown as Record<string, unknown>),
      score: 1.0,
      matchedBy: 'exact' as const,
    }))
  }

  /** 查询文件中的所有符号 */
  getSymbolsByFile(filePath: string): SymbolInfo[] {
    const db = this.db()
    const rows = db.prepare('SELECT * FROM symbols WHERE file_path = ? ORDER BY line ASC').all(filePath)
    return rows.map((r) => this.rowToSymbol(r as unknown as Record<string, unknown>))
  }

  /** 查询一个文件 import 了哪些文件 */
  getImports(filePath: string): ImportEdge[] {
    const db = this.db()
    const rows = db.prepare('SELECT * FROM import_edges WHERE from_file = ?').all(filePath)
    return rows.map((r) => this.rowToImportEdge(r as unknown as Record<string, unknown>))
  }

  /** 查询哪些文件 import 了某个文件 */
  getImporters(filePath: string): ImportEdge[] {
    const db = this.db()
    const rows = db.prepare('SELECT * FROM import_edges WHERE to_file = ?').all(filePath)
    return rows.map((r) => this.rowToImportEdge(r as unknown as Record<string, unknown>))
  }

  /** 沿依赖图向外扩展 N 层，找到所有相关文件 */
  getRelatedFiles(filePath: string, depth: number = 2): Map<string, number> {
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

        const rows = db.prepare(`
          SELECT from_file as p FROM import_edges WHERE to_file IN (${placeholders})
          UNION
          SELECT to_file as p FROM import_edges WHERE from_file IN (${placeholders})
        `).all(...chunk, ...chunk)

        for (const row of rows) {
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
  clearFile(filePath: string): void {
    const db = this.db()
    db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath)
    db.prepare('DELETE FROM import_edges WHERE from_file = ? OR to_file = ?').run(filePath, filePath)
    db.prepare('DELETE FROM symbol_refs WHERE file_path = ?').run(filePath)
  }

  /** 清除所有数据 */
  clearAll(): void {
    const db = this.db()
    db.prepare('DELETE FROM symbols').run()
    db.prepare('DELETE FROM import_edges').run()
    db.prepare('DELETE FROM symbol_refs').run()
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
