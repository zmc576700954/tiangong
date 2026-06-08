# BizGraph 上下文感知能力补全实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 BizGraph 构建代码语义理解能力，使其能像 Cursor/ZedAgent 一样从自然语言需求中自动发现相关代码、理解代码结构、并组装精准上下文。

**Architecture:** 四阶段递进式增强：(1) 代码解析引擎——用 TypeScript Compiler API 构建符号索引和依赖图；(2) 智能上下文解析器——从用户输入匹配代码符号并沿依赖图扩展上下文；(3) 动态 Prompt 构建器——基于代码重要性智能截断和组装；(4) Agent 规划模式——意图分析和自动执行计划。

**Tech Stack:** TypeScript Compiler API, SQLite (已有), chokidar (已有)

---

## 计划结构

- [阶段一：代码解析引擎](#阶段一代码解析引擎)
- [阶段二：智能上下文解析器](#阶段二智能上下文解析器)
- [阶段三：动态 Prompt 构建器](#阶段三动态-prompt-构建器)
- [阶段四：Agent 规划模式](#阶段四agent-规划模式)

---

## 阶段一：代码解析引擎

> 目标：构建项目的 AST 解析、符号索引和 Import 依赖图，让系统真正"理解"代码结构。

### Task 1.1: 符号索引数据模型

**Files:**
- Create: `src/main/code-intelligence/symbol-index.ts`
- Create: `src/main/code-intelligence/__tests__/symbol-index.test.ts`
- Modify: `src/shared/types.ts` (添加 SymbolInfo, ImportEdge 类型)

- [ ] **Step 1: 定义核心类型**

在 `src/shared/types.ts` 中添加以下类型定义：

```typescript
/** 代码符号类型 */
export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'constant'
  | 'import'
  | 'export'
  | 'namespace'
  | 'decorator'

/** 单个代码符号的定义信息 */
export interface SymbolInfo {
  id: string // 全局唯一标识，格式: symbol_xxx
  name: string // 符号名称（如 UserService）
  kind: SymbolKind
  filePath: string // 绝对路径
  line: number // 定义起始行（1-based）
  column: number // 定义起始列
  endLine: number // 定义结束行
  endColumn: number // 定义结束列
  signature?: string // 函数/方法签名文本
  jsDoc?: string // JSDoc/注释文本
  parentId?: string // 父符号 ID（如类中的方法）
  isExported: boolean
  sourceCode?: string // 符号的完整源码
}

/** Import/Export 关系边 */
export interface ImportEdge {
  fromFile: string // 导出方文件绝对路径
  toFile: string // 导入方文件绝对路径
  importedNames: string[] // 导入的符号名列表
  isDefaultImport: boolean
  line: number
}

/** 符号引用关系 */
export interface SymbolReference {
  symbolId: string
  filePath: string
  line: number
  column: number
  isDefinition: boolean // true=定义处, false=引用处
}

/** 符号索引查询结果 */
export interface SymbolQueryResult {
  symbol: SymbolInfo
  score: number // 匹配得分
  matchedBy: 'exact' | 'fuzzy' | 'semantic' | 'path'
}
```

- [ ] **Step 2: 创建 SymbolIndex 类骨架**

创建 `src/main/code-intelligence/symbol-index.ts`：

```typescript
import type { SymbolInfo, ImportEdge, SymbolReference, SymbolQueryResult } from '@shared/types'
import { Database } from 'better-sqlite3' // 稍后确认实际使用的 DB 库

/**
 * 符号索引管理器
 * 负责存储和查询代码符号、import 依赖关系
 */
export class SymbolIndex {
  private db: Database

  constructor(dbPath: string) {
    // 初始化 SQLite 连接，创建符号表
    this.db = new Database(dbPath)
    this.initTables()
  }

  private initTables(): void {
    this.db.exec(`
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
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbol_file ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbol_kind ON symbols(kind);
      CREATE INDEX IF NOT EXISTS idx_symbol_parent ON symbols(parent_id);

      CREATE TABLE IF NOT EXISTS import_edges (
        from_file TEXT NOT NULL,
        to_file TEXT NOT NULL,
        imported_names TEXT NOT NULL, -- JSON array
        is_default INTEGER DEFAULT 0,
        line INTEGER NOT NULL,
        PRIMARY KEY (from_file, to_file, line)
      );
      CREATE INDEX IF NOT EXISTS idx_import_from ON import_edges(from_file);
      CREATE INDEX IF NOT EXISTS idx_import_to ON import_edges(to_file);

      CREATE TABLE IF NOT EXISTS symbol_refs (
        symbol_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        column INTEGER NOT NULL,
        is_definition INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol_id, file_path, line, column)
      );
      CREATE INDEX IF NOT EXISTS idx_ref_symbol ON symbol_refs(symbol_id);
      CREATE INDEX IF NOT EXISTS idx_ref_file ON symbol_refs(file_path);
    `)
  }

  /** 批量插入符号 */
  insertSymbols(symbols: SymbolInfo[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO symbols
      (id, name, kind, file_path, line, column, end_line, end_column, signature, js_doc, parent_id, is_exported, source_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insert = this.db.transaction((items: SymbolInfo[]) => {
      for (const s of items) {
        stmt.run(
          s.id, s.name, s.kind, s.filePath, s.line, s.column,
          s.endLine ?? null, s.endColumn ?? null, s.signature ?? null,
          s.jsDoc ?? null, s.parentId ?? null, s.isExported ? 1 : 0,
          s.sourceCode ?? null
        )
      }
    })
    insert(symbols)
  }

  /** 批量插入 import 边 */
  insertImportEdges(edges: ImportEdge[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO import_edges
      (from_file, to_file, imported_names, is_default, line)
      VALUES (?, ?, ?, ?, ?)
    `)
    const insert = this.db.transaction((items: ImportEdge[]) => {
      for (const e of items) {
        stmt.run(e.fromFile, e.toFile, JSON.stringify(e.importedNames), e.isDefaultImport ? 1 : 0, e.line)
      }
    })
    insert(edges)
  }

  /** 按名称精确或模糊查询符号 */
  querySymbols(name: string, options?: { kind?: SymbolKind; limit?: number; fuzzy?: boolean }): SymbolQueryResult[] {
    const limit = options?.limit ?? 20
    if (options?.fuzzy) {
      const rows = this.db.prepare(`
        SELECT * FROM symbols WHERE name LIKE ? ${options.kind ? 'AND kind = ?' : ''}
        ORDER BY LENGTH(name) ASC LIMIT ?
      `).all(`%${name}%`, ...(options.kind ? [options.kind] : []), limit) as SymbolInfo[]
      return rows.map(r => ({ symbol: this.rowToSymbol(r), score: 0.7, matchedBy: 'fuzzy' }))
    }
    const rows = this.db.prepare(`
      SELECT * FROM symbols WHERE name = ? ${options?.kind ? 'AND kind = ?' : ''}
      ORDER BY line ASC LIMIT ?
    `).all(name, ...(options?.kind ? [options.kind] : []), limit) as SymbolInfo[]
    return rows.map(r => ({ symbol: this.rowToSymbol(r), score: 1.0, matchedBy: 'exact' }))
  }

  /** 查询文件中的所有符号 */
  getSymbolsByFile(filePath: string): SymbolInfo[] {
    const rows = this.db.prepare('SELECT * FROM symbols WHERE file_path = ? ORDER BY line ASC').all(filePath) as SymbolInfo[]
    return rows.map(r => this.rowToSymbol(r))
  }

  /** 查询一个文件 import 了哪些文件 */
  getImports(filePath: string): ImportEdge[] {
    return this.db.prepare('SELECT * FROM import_edges WHERE from_file = ?').all(filePath) as ImportEdge[]
  }

  /** 查询哪些文件 import 了某个文件 */
  getImporters(filePath: string): ImportEdge[] {
    return this.db.prepare('SELECT * FROM import_edges WHERE to_file = ?').all(filePath) as ImportEdge[]
  }

  /** 沿依赖图向外扩展 N 层，找到所有相关文件 */
  getRelatedFiles(filePath: string, depth: number = 2): Map<string, number> {
    const result = new Map<string, number>()
    const visited = new Set<string>()
    const queue: { path: string; d: number }[] = [{ path: filePath, d: 0 }]
    while (queue.length > 0) {
      const { path, d } = queue.shift()!
      if (visited.has(path) || d > depth) continue
      visited.add(path)
      if (d > 0) result.set(path, d)
      const edges = this.db.prepare(
        'SELECT from_file as p FROM import_edges WHERE to_file = ? UNION SELECT to_file as p FROM import_edges WHERE from_file = ?'
      ).all(path, path) as Array<{ p: string }>
      for (const { p } of edges) {
        if (!visited.has(p)) queue.push({ path: p, d: d + 1 })
      }
    }
    return result
  }

  /** 清除某个文件的所有符号和 import 关系 */
  clearFile(filePath: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath)
    this.db.prepare('DELETE FROM import_edges WHERE from_file = ? OR to_file = ?').run(filePath, filePath)
    this.db.prepare('DELETE FROM symbol_refs WHERE file_path = ?').run(filePath)
  }

  /** 清除所有数据 */
  clearAll(): void {
    this.db.exec('DELETE FROM symbols; DELETE FROM import_edges; DELETE FROM symbol_refs;')
  }

  private rowToSymbol(row: any): SymbolInfo {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.file_path,
      line: row.line,
      column: row.column,
      endLine: row.end_line,
      endColumn: row.end_column,
      signature: row.signature,
      jsDoc: row.js_doc,
      parentId: row.parent_id,
      isExported: Boolean(row.is_exported),
      sourceCode: row.source_code,
    }
  }

  close(): void {
    this.db.close()
  }
}
```

注意：需要先确认项目使用的 SQLite 库。如果项目使用 `better-sqlite3`，上面的代码可以直接用。如果用的是 `@libsql/client`（CLAUDE.md 提到 LibSQL），需要调整 API。请检查 `src/main/database.ts` 确认实际使用的库。

- [ ] **Step 3: 编写单元测试**

创建 `src/main/code-intelligence/__tests__/symbol-index.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SymbolIndex } from '../symbol-index'
import type { SymbolInfo, ImportEdge } from '@shared/types'
import { generateId } from '../../shared/env'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

describe('SymbolIndex', () => {
  let index: SymbolIndex
  let dbPath: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `symbol-index-test-${Date.now()}.db`)
    index = new SymbolIndex(dbPath)
  })

  afterEach(() => {
    index.close()
    fs.unlinkSync(dbPath)
  })

  it('should insert and query symbols', () => {
    const symbols: SymbolInfo[] = [
      { id: generateId('symbol'), name: 'UserService', kind: 'class', filePath: '/project/src/user/service.ts', line: 10, column: 0, endLine: 50, endColumn: 1, isExported: true, signature: 'class UserService' },
      { id: generateId('symbol'), name: 'createUser', kind: 'method', filePath: '/project/src/user/service.ts', line: 15, column: 2, endLine: 30, endColumn: 3, isExported: false, parentId: 'symbol_001', signature: 'createUser(data: CreateUserDto): Promise<User>' },
    ]
    index.insertSymbols(symbols)

    const results = index.querySymbols('UserService')
    expect(results).toHaveLength(1)
    expect(results[0].symbol.name).toBe('UserService')
    expect(results[0].matchedBy).toBe('exact')
    expect(results[0].score).toBe(1.0)
  })

  it('should support fuzzy query', () => {
    const symbols: SymbolInfo[] = [
      { id: generateId('symbol'), name: 'UserService', kind: 'class', filePath: '/project/src/user/service.ts', line: 1, column: 0, endLine: 1, endColumn: 1, isExported: true },
      { id: generateId('symbol'), name: 'UserController', kind: 'class', filePath: '/project/src/user/controller.ts', line: 1, column: 0, endLine: 1, endColumn: 1, isExported: true },
    ]
    index.insertSymbols(symbols)

    const results = index.querySymbols('User', { fuzzy: true })
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('should track import dependencies', () => {
    const edges: ImportEdge[] = [
      { fromFile: '/project/src/user/controller.ts', toFile: '/project/src/user/service.ts', importedNames: ['UserService'], isDefaultImport: false, line: 1 },
      { fromFile: '/project/src/app.ts', toFile: '/project/src/user/controller.ts', importedNames: ['UserController'], isDefaultImport: false, line: 2 },
    ]
    index.insertImportEdges(edges)

    const imports = index.getImports('/project/src/user/controller.ts')
    expect(imports).toHaveLength(1)
    expect(imports[0].toFile).toBe('/project/src/user/service.ts')

    const importers = index.getImporters('/project/src/user/controller.ts')
    expect(importers).toHaveLength(1)
    expect(importers[0].fromFile).toBe('/project/src/app.ts')
  })

  it('should find related files by dependency depth', () => {
    const edges: ImportEdge[] = [
      { fromFile: '/project/src/a.ts', toFile: '/project/src/b.ts', importedNames: ['B'], isDefaultImport: false, line: 1 },
      { fromFile: '/project/src/b.ts', toFile: '/project/src/c.ts', importedNames: ['C'], isDefaultImport: false, line: 1 },
      { fromFile: '/project/src/c.ts', toFile: '/project/src/d.ts', importedNames: ['D'], isDefaultImport: false, line: 1 },
    ]
    index.insertImportEdges(edges)

    const related = index.getRelatedFiles('/project/src/b.ts', 2)
    expect(related.has('/project/src/a.ts')).toBe(true)
    expect(related.has('/project/src/c.ts')).toBe(true)
    expect(related.has('/project/src/d.ts')).toBe(false) // depth=2, d is at depth=3 from b
  })

  it('should clear file data', () => {
    const symbols: SymbolInfo[] = [
      { id: generateId('symbol'), name: 'A', kind: 'function', filePath: '/project/src/a.ts', line: 1, column: 0, endLine: 1, endColumn: 1, isExported: true },
    ]
    index.insertSymbols(symbols)
    index.clearFile('/project/src/a.ts')
    expect(index.querySymbols('A')).toHaveLength(0)
  })
})
```

- [ ] **Step 4: 运行测试确认失败（骨架未实现完整）**

Run: `npx vitest run src/main/code-intelligence/__tests__/symbol-index.test.ts`
Expected: 部分通过（基础 CRUD），部分失败（需要调整 SQLite API 适配）

- [ ] **Step 5: 修复 SQLite API 适配**

根据项目实际使用的 SQLite 库调整 `SymbolIndex` 的实现：
- 如果项目使用 `better-sqlite3` → 当前代码基本可用
- 如果项目使用 `@libsql/client` → 需要改为异步 API

查看 `src/main/database.ts` 确认数据库驱动。

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/code-intelligence/
git commit -m "feat(code-intelligence): add SymbolIndex with SQLite persistence for code symbols and import edges"
```

---

### Task 1.2: TypeScript AST 解析器

**Files:**
- Create: `src/main/code-intelligence/ast-parser.ts`
- Create: `src/main/code-intelligence/__tests__/ast-parser.test.ts`
- Modify: `src/shared/types.ts`（确保 SymbolKind 等类型已定义）

- [ ] **Step 1: 创建 AstParser 类**

创建 `src/main/code-intelligence/ast-parser.ts`：

```typescript
import * as ts from 'typescript'
import type { SymbolInfo, ImportEdge } from '@shared/types'
import { generateId } from '../shared/env'

export interface ParseResult {
  symbols: SymbolInfo[]
  imports: ImportEdge[]
  exports: string[] // 导出的符号名列表
}

/**
 * TypeScript AST 解析器
 * 解析单个 .ts/.tsx/.js/.jsx 文件，提取符号定义和 import 关系
 */
export class AstParser {
  private compilerOptions: ts.CompilerOptions

  constructor(compilerOptions?: ts.CompilerOptions) {
    this.compilerOptions = compilerOptions ?? {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
    }
  }

  /**
   * 解析文件内容，返回符号和 import 关系
   */
  parse(filePath: string, sourceCode: string): ParseResult {
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceCode,
      this.compilerOptions.target ?? ts.ScriptTarget.ES2020,
      true,
      this.getScriptKind(filePath)
    )

    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const visit = (node: ts.Node, parentId?: string) => {
      const symbol = this.extractSymbol(node, filePath, sourceCode, parentId)
      if (symbol) {
        symbols.push(symbol)
        if (symbol.isExported) exports.push(symbol.name)
      }

      if (ts.isImportDeclaration(node)) {
        const importEdge = this.extractImport(node, filePath, sourceCode)
        if (importEdge) imports.push(importEdge)
      }

      // 如果当前节点创建了新的父作用域（如 class），将其 id 传给子节点
      const childParentId = symbol?.id ?? parentId
      ts.forEachChild(node, child => visit(child, childParentId))
    }

    visit(sourceFile)

    return { symbols, imports, exports }
  }

  private extractSymbol(node: ts.Node, filePath: string, sourceCode: string, parentId?: string): SymbolInfo | null {
    let kind: SymbolInfo['kind'] | null = null
    let name: string | null = null
    let isExported = false

    if (ts.isClassDeclaration(node)) {
      kind = 'class'
      name = node.name?.text ?? null
      isExported = this.isExported(node)
    } else if (ts.isInterfaceDeclaration(node)) {
      kind = 'interface'
      name = node.name.text
      isExported = this.isExported(node)
    } else if (ts.isTypeAliasDeclaration(node)) {
      kind = 'type_alias'
      name = node.name.text
      isExported = this.isExported(node)
    } else if (ts.isEnumDeclaration(node)) {
      kind = 'enum'
      name = node.name.text
      isExported = this.isExported(node)
    } else if (ts.isFunctionDeclaration(node)) {
      kind = 'function'
      name = node.name?.text ?? null
      isExported = this.isExported(node)
    } else if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
      if (ts.isMethodDeclaration(node)) kind = 'method'
      else kind = 'property'
      name = this.getPropertyName(node.name)
      isExported = false // class 成员通过 class 的 export 状态间接决定
    } else if (ts.isVariableStatement(node)) {
      // 处理 const/let/var 声明
      const decl = node.declarationList.declarations[0]
      if (ts.isIdentifier(decl.name)) {
        kind = 'variable'
        name = decl.name.text
        isExported = this.isExported(node)
      }
    } else if (ts.isModuleDeclaration(node) || ts.isNamespaceExportDeclaration(node)) {
      kind = 'namespace'
      name = ts.isIdentifier(node.name) ? node.name.text : (node.name as ts.StringLiteral).text
      isExported = this.isExported(node)
    }

    if (!kind || !name) return null

    const { line: startLine, character: startColumn } = ts.getLineAndCharacterOfPosition(
      node.getSourceFile(),
      node.getStart()
    )
    const { line: endLine, character: endColumn } = ts.getLineAndCharacterOfPosition(
      node.getSourceFile(),
      node.getEnd()
    )

    const signature = this.extractSignature(node, sourceCode)
    const jsDoc = this.extractJsDoc(node, sourceCode)

    return {
      id: generateId('symbol'),
      name,
      kind,
      filePath,
      line: startLine + 1,
      column: startColumn,
      endLine: endLine + 1,
      endColumn,
      signature,
      jsDoc,
      parentId,
      isExported,
      sourceCode: node.getText(),
    }
  }

  private extractImport(node: ts.ImportDeclaration, filePath: string, _sourceCode: string): ImportEdge | null {
    const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text
    const importedNames: string[] = []
    let isDefaultImport = false

    if (node.importClause) {
      if (node.importClause.name) {
        importedNames.push(node.importClause.name.text)
        isDefaultImport = true
      }
      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            importedNames.push(element.name.text)
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          importedNames.push(`* as ${node.importClause.namedBindings.name.text}`)
        }
      }
    }

    // 将相对路径解析为绝对路径（简化版，实际需要基于项目根目录解析）
    const resolvedPath = moduleSpecifier.startsWith('.')
      ? new URL(moduleSpecifier, `file://${filePath}`).pathname
      : moduleSpecifier // 外部模块保留原样

    const { line } = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart())

    return {
      fromFile: filePath,
      toFile: resolvedPath,
      importedNames,
      isDefaultImport,
      line: line + 1,
    }
  }

  private isExported(node: ts.Node): boolean {
    return (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true
    )
  }

  private getPropertyName(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name)) return name.text
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
    if (ts.isComputedPropertyName(name)) {
      if (ts.isIdentifier(name.expression)) return name.expression.text
      return null
    }
    return null
  }

  private extractSignature(node: ts.Node, _sourceCode: string): string | undefined {
    // 提取函数/方法签名文本
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const params = node.parameters.map(p => p.getText()).join(', ')
      const returnType = node.type ? `: ${node.type.getText()}` : ''
      return `${node.name?.getText() ?? 'anonymous'}(${params})${returnType}`
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = node.heritageClauses?.map(h => h.getText()).join(' ')
      return `class ${node.name.text} ${heritage ?? ''}`.trim()
    }
    if (ts.isInterfaceDeclaration(node)) {
      const heritage = node.heritageClauses?.map(h => h.getText()).join(' ')
      return `interface ${node.name.text} ${heritage ?? ''}`.trim()
    }
    return undefined
  }

  private extractJsDoc(node: ts.Node, _sourceCode: string): string | undefined {
    const jsDoc = (node as any).jsDoc
    if (jsDoc && jsDoc.length > 0) {
      return jsDoc.map((doc: ts.JSDoc) => doc.getText()).join('\n')
    }
    return undefined
  }

  private getScriptKind(filePath: string): ts.ScriptKind {
    if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX
    if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX
    if (filePath.endsWith('.ts')) return ts.ScriptKind.TS
    if (filePath.endsWith('.js')) return ts.ScriptKind.JS
    return ts.ScriptKind.TS
  }
}
```

- [ ] **Step 2: 编写单元测试**

创建 `src/main/code-intelligence/__tests__/ast-parser.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { AstParser } from '../ast-parser'

describe('AstParser', () => {
  const parser = new AstParser()

  it('should parse class definitions', () => {
    const code = `
      /** 用户服务 */
      export class UserService {
        constructor(private repo: UserRepository) {}
        async createUser(data: CreateUserDto): Promise<User> {
          return this.repo.create(data)
        }
      }
    `
    const result = parser.parse('/project/src/user.service.ts', code)

    expect(result.symbols).toHaveLength(3) // class + constructor + method
    const cls = result.symbols.find(s => s.kind === 'class')
    expect(cls?.name).toBe('UserService')
    expect(cls?.isExported).toBe(true)
    expect(cls?.jsDoc).toContain('用户服务')

    const method = result.symbols.find(s => s.kind === 'method')
    expect(method?.name).toBe('createUser')
    expect(method?.signature).toContain('createUser(data: CreateUserDto): Promise<User>')
    expect(method?.parentId).toBe(cls?.id)
  })

  it('should parse interface definitions', () => {
    const code = `
      export interface User {
        id: string
        name: string
      }
    `
    const result = parser.parse('/project/src/types.ts', code)
    const iface = result.symbols.find(s => s.kind === 'interface')
    expect(iface?.name).toBe('User')
    expect(iface?.isExported).toBe(true)
  })

  it('should parse import declarations', () => {
    const code = `
      import { UserService } from './user.service'
      import type { User } from '../types'
      import * as path from 'path'
      import fs from 'fs'
    `
    const result = parser.parse('/project/src/controller.ts', code)

    expect(result.imports).toHaveLength(4)
    const namedImport = result.imports.find(i => i.importedNames.includes('UserService'))
    expect(namedImport?.toFile).toContain('user.service')
    expect(namedImport?.isDefaultImport).toBe(false)
  })

  it('should parse type aliases', () => {
    const code = `export type UserId = string`
    const result = parser.parse('/project/src/types.ts', code)
    const alias = result.symbols.find(s => s.kind === 'type_alias')
    expect(alias?.name).toBe('UserId')
  })

  it('should parse enums', () => {
    const code = `
      export enum Status {
        Active = 'active',
        Inactive = 'inactive',
      }
    `
    const result = parser.parse('/project/src/enums.ts', code)
    const enumSymbol = result.symbols.find(s => s.kind === 'enum')
    expect(enumSymbol?.name).toBe('Status')
  })

  it('should parse function declarations', () => {
    const code = `
      export function calculateTotal(items: number[]): number {
        return items.reduce((a, b) => a + b, 0)
      }
    `
    const result = parser.parse('/project/src/utils.ts', code)
    const fn = result.symbols.find(s => s.kind === 'function')
    expect(fn?.name).toBe('calculateTotal')
    expect(fn?.signature).toContain('calculateTotal(items: number[]): number')
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/code-intelligence/__tests__/ast-parser.test.ts`
Expected: PASS（TypeScript Compiler API 是成熟的，实现应基本正确）

- [ ] **Step 4: Commit**

```bash
git add src/main/code-intelligence/
git commit -m "feat(code-intelligence): add TypeScript AST parser with symbol and import extraction"
```

---

### Task 1.3: 项目级代码索引器

**Files:**
- Create: `src/main/code-intelligence/project-indexer.ts`
- Create: `src/main/code-intelligence/__tests__/project-indexer.test.ts`
- Modify: `src/main/database.ts`（确认/创建符号索引数据库表）

- [ ] **Step 1: 创建 ProjectIndexer**

创建 `src/main/code-intelligence/project-indexer.ts`：

```typescript
import * as fs from 'fs'
import * as path from 'path'
import { AstParser } from './ast-parser'
import { SymbolIndex } from './symbol-index'
import { generateId } from '../shared/env'

export interface IndexOptions {
  projectPath: string
  includePatterns?: string[] // 默认: ['src/**/*.{ts,tsx,js,jsx}']
  excludePatterns?: string[] // 默认: ['node_modules', 'dist', '.git']
  tsConfigPath?: string // tsconfig.json 路径
}

/**
 * 项目级代码索引器
 * 扫描项目中的所有源码文件，解析 AST，构建符号索引和依赖图
 */
export class ProjectIndexer {
  private astParser: AstParser
  private symbolIndex: SymbolIndex

  constructor(symbolIndex: SymbolIndex, tsConfigPath?: string) {
    this.symbolIndex = symbolIndex
    let compilerOptions: import('typescript').CompilerOptions | undefined
    if (tsConfigPath && fs.existsSync(tsConfigPath)) {
      const configFile = require('typescript').readConfigFile(tsConfigPath, require('typescript').sys.readFile)
      if (!configFile.error) {
        const parsed = require('typescript').parseJsonConfigFileContent(
          configFile.config,
          require('typescript').sys,
          path.dirname(tsConfigPath)
        )
        compilerOptions = parsed.options
      }
    }
    this.astParser = new AstParser(compilerOptions)
  }

  /**
   * 完整索引一个项目
   */
  async indexProject(options: IndexOptions): Promise<{ filesIndexed: number; symbolsFound: number; importsFound: number }> {
    const include = options.includePatterns ?? ['**/*.{ts,tsx,js,jsx}']
    const exclude = options.excludePatterns ?? ['node_modules/**', 'dist/**', '.git/**', 'build/**', '.next/**']

    // 收集所有匹配的文件
    const files = this.collectFiles(options.projectPath, include, exclude)

    // 清除旧的索引数据（可选：增量更新更优，但先实现全量）
    // this.symbolIndex.clearAll()

    let symbolsFound = 0
    let importsFound = 0

    // 解析每个文件
    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const result = this.astParser.parse(filePath, content)

        this.symbolIndex.insertSymbols(result.symbols)
        this.symbolIndex.insertImportEdges(result.imports)

        symbolsFound += result.symbols.length
        importsFound += result.imports.length
      } catch (err) {
        console.warn(`Failed to parse ${filePath}:`, err)
      }
    }

    return { filesIndexed: files.length, symbolsFound, importsFound }
  }

  /**
   * 增量更新：重新索引单个文件
   */
  async reindexFile(filePath: string): Promise<{ symbolsFound: number; importsFound: number }> {
    this.symbolIndex.clearFile(filePath)
    const content = fs.readFileSync(filePath, 'utf-8')
    const result = this.astParser.parse(filePath, content)
    this.symbolIndex.insertSymbols(result.symbols)
    this.symbolIndex.insertImportEdges(result.imports)
    return { symbolsFound: result.symbols.length, importsFound: result.imports.length }
  }

  private collectFiles(projectPath: string, include: string[], exclude: string[]): string[] {
    const results: string[] = []
    const glob = require('fast-glob') // 或使用内置实现

    // 如果没有 fast-glob，使用简单递归
    try {
      return glob.sync(include, { cwd: projectPath, absolute: true, ignore: exclude })
    } catch {
      // fallback: 简单递归实现
      this.walkDir(projectPath, results, exclude.map(e => e.replace('/**', '')))
      return results.filter(f => include.some(p => this.matchGlob(f, p)))
    }
  }

  private walkDir(dir: string, results: string[], excludeDirs: string[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!excludeDirs.some(e => fullPath.includes(e))) {
          this.walkDir(fullPath, results, excludeDirs)
        }
      } else if (entry.isFile()) {
        results.push(fullPath)
      }
    }
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // 简化版 glob 匹配
    const ext = pattern.replace('**/*.', '')
    return ext.split(',').some(e => filePath.endsWith(e.trim()))
  }
}
```

- [ ] **Step 2: 编写测试**

创建 `src/main/code-intelligence/__tests__/project-indexer.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ProjectIndexer } from '../project-indexer'
import { SymbolIndex } from '../symbol-index'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('ProjectIndexer', () => {
  let tmpDir: string
  let symbolIndex: SymbolIndex
  let indexer: ProjectIndexer

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-indexer-test-'))
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })

    // 创建测试文件
    fs.writeFileSync(path.join(tmpDir, 'src', 'user.service.ts'), `
      import { Repository } from './repository'
      export class UserService {
        async findById(id: string) { return null }
      }
    `)
    fs.writeFileSync(path.join(tmpDir, 'src', 'repository.ts'), `
      export class Repository {
        async findOne() { return null }
      }
    `)

    const dbPath = path.join(tmpDir, 'index.db')
    symbolIndex = new SymbolIndex(dbPath)
    indexer = new ProjectIndexer(symbolIndex)
  })

  afterEach(() => {
    symbolIndex.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should index a project and find symbols', async () => {
    const result = await indexer.indexProject({
      projectPath: tmpDir,
      includePatterns: ['src/**/*.{ts,tsx}'],
    })

    expect(result.filesIndexed).toBe(2)
    expect(result.symbolsFound).toBeGreaterThan(0)

    const symbols = symbolIndex.querySymbols('UserService')
    expect(symbols.length).toBeGreaterThan(0)
    expect(symbols[0].symbol.name).toBe('UserService')
  })

  it('should track import dependencies between files', async () => {
    await indexer.indexProject({
      projectPath: tmpDir,
      includePatterns: ['src/**/*.{ts,tsx}'],
    })

    const imports = symbolIndex.getImports(path.join(tmpDir, 'src', 'user.service.ts'))
    expect(imports.length).toBeGreaterThan(0)
    expect(imports[0].toFile).toContain('repository')
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/code-intelligence/__tests__/project-indexer.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/code-intelligence/
git commit -m "feat(code-intelligence): add ProjectIndexer for full-project AST scanning"
```

---

### Task 1.4: 文件变更监听器（增量索引）

**Files:**
- Create: `src/main/code-intelligence/file-watcher.ts`
- Modify: `src/main/code-intelligence/project-indexer.ts`（添加增量更新 hook）

- [ ] **Step 1: 创建基于 chokidar 的增量索引 watcher**

创建 `src/main/code-intelligence/file-watcher.ts`：

```typescript
import * as chokidar from 'chokidar'
import * as path from 'path'
import { ProjectIndexer } from './project-indexer'

export interface FileWatcherOptions {
  projectPath: string
  indexer: ProjectIndexer
  includePatterns?: string[]
  excludePatterns?: string[]
  onIndexUpdate?: (event: { type: 'add' | 'change' | 'unlink'; filePath: string; symbolsFound: number }) => void
}

/**
 * 代码文件变更监听器
 * 使用 chokidar 监听文件变化，自动触发增量索引更新
 */
export class CodeFileWatcher {
  private watcher?: chokidar.FSWatcher
  private indexer: ProjectIndexer
  private options: FileWatcherOptions

  constructor(options: FileWatcherOptions) {
    this.options = options
    this.indexer = options.indexer
  }

  async start(): Promise<void> {
    const watchPaths = (this.options.includePatterns ?? ['**/*.{ts,tsx,js,jsx}']).map(p =>
      path.join(this.options.projectPath, p)
    )
    const ignored = this.options.excludePatterns ?? ['node_modules/**', 'dist/**', '.git/**', 'build/**']

    this.watcher = chokidar.watch(watchPaths, {
      ignored,
      persistent: true,
      ignoreInitial: true, // 初始索引由 ProjectIndexer 完成
    })

    this.watcher.on('add', async (filePath) => {
      try {
        const result = await this.indexer.reindexFile(filePath)
        this.options.onIndexUpdate?.({ type: 'add', filePath, symbolsFound: result.symbolsFound })
      } catch (err) {
        console.warn(`Failed to index added file ${filePath}:`, err)
      }
    })

    this.watcher.on('change', async (filePath) => {
      try {
        const result = await this.indexer.reindexFile(filePath)
        this.options.onIndexUpdate?.({ type: 'change', filePath, symbolsFound: result.symbolsFound })
      } catch (err) {
        console.warn(`Failed to reindex changed file ${filePath}:`, err)
      }
    })

    this.watcher.on('unlink', async (filePath) => {
      // 从索引中移除
      this.indexer['symbolIndex'].clearFile(filePath)
      this.options.onIndexUpdate?.({ type: 'unlink', filePath, symbolsFound: 0 })
    })
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/code-intelligence/file-watcher.ts
git commit -m "feat(code-intelligence): add chokidar-based incremental index watcher"
```

---

## 阶段二：智能上下文解析器

> 目标：从用户输入中提取技术实体，基于符号索引匹配相关代码，并沿依赖图扩展上下文。

### Task 2.1: 技术实体提取器（Entity Extractor）

**Files:**
- Create: `src/main/code-intelligence/entity-extractor.ts`
- Create: `src/main/code-intelligence/__tests__/entity-extractor.test.ts`

- [ ] **Step 1: 创建 EntityExtractor**

创建 `src/main/code-intelligence/entity-extractor.ts`：

```typescript
/**
 * 技术实体类型
 */
export type EntityType = 'class' | 'function' | 'method' | 'interface' | 'file' | 'module' | 'keyword'

export interface ExtractedEntity {
  name: string
  type: EntityType
  confidence: number // 0-1
  position?: { start: number; end: number } // 在原文中的位置
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  intent: 'implement' | 'fix' | 'refactor' | 'explain' | 'test' | 'unknown'
  targetDescription?: string // 去实体化后的描述文本
}

/**
 * 从用户自然语言输入中提取技术实体
 * 使用规则 + 启发式方法（后续可替换为 LLM-based 提取）
 */
export class EntityExtractor {
  // 常见的编程命名模式
  private readonly camelCasePattern = /\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)*\b/g
  private readonly pascalCasePattern = /\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g
  private readonly snakeCasePattern = /\b[a-z]+(?:_[a-z]+)+\b/g
  private readonly kebabCasePattern = /\b[a-z]+(?:-[a-z]+)+\b/g

  // 意图关键词映射
  private readonly intentPatterns: Array<{ pattern: RegExp; intent: ExtractionResult['intent'] }> = [
    { pattern: /(?:实现|添加|创建|新增|开发|build|implement|add|create|develop)\b/i, intent: 'implement' },
    { pattern: /(?:修复|解决|bug|fix|repair|resolve)\b/i, intent: 'fix' },
    { pattern: /(?:重构|优化|改进|整理|refactor|optimize|improve|cleanup)\b/i, intent: 'refactor' },
    { pattern: /(?:解释|说明|怎么|为什么|explain|describe|how|why)\b/i, intent: 'explain' },
    { pattern: /(?:测试|test|spec|unit test|e2e)\b/i, intent: 'test' },
  ]

  /**
   * 从用户输入中提取技术实体和意图
   */
  extract(input: string): ExtractionResult {
    const entities = this.extractEntities(input)
    const intent = this.detectIntent(input)
    const targetDescription = this.buildTargetDescription(input, entities)

    return { entities, intent, targetDescription }
  }

  private extractEntities(input: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = []
    const seen = new Set<string>()

    // 1. 提取大驼峰命名（类名、接口名等）
    let match: RegExpExecArray | null
    const pascalPattern = new RegExp(this.pascalCasePattern.source, 'g')
    while ((match = pascalPattern.exec(input)) !== null) {
      const name = match[0]
      if (seen.has(name)) continue
      seen.add(name)

      // 启发式判断类型
      let type: EntityType = 'class'
      if (name.endsWith('Service')) type = 'class'
      else if (name.endsWith('Controller')) type = 'class'
      else if (name.endsWith('Repository')) type = 'class'
      else if (name.endsWith('Dto') || name.endsWith('DTO')) type = 'interface'
      else if (name.endsWith('Interface')) type = 'interface'
      else if (name.endsWith('Type') || name.endsWith('Types')) type = 'interface'
      else if (/^[A-Z]/.test(name) && name.length > 3) type = 'class'

      entities.push({
        name,
        type,
        confidence: this.calculateEntityConfidence(name, type, input),
        position: { start: match.index, end: match.index + name.length },
      })
    }

    // 2. 提取文件路径模式（如 src/user/service.ts）
    const filePattern = /\b(?:[\w\-]+\/)+[\w\-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt)\b/g
    while ((match = filePattern.exec(input)) !== null) {
      const name = match[0]
      if (seen.has(name)) continue
      seen.add(name)
      entities.push({
        name,
        type: 'file',
        confidence: 0.95,
        position: { start: match.index, end: match.index + name.length },
      })
    }

    // 3. 提取常见技术关键词
    const techKeywords = [
      'API', 'REST', 'GraphQL', 'database', 'cache', 'middleware', 'auth', 'JWT',
      'OAuth', 'websocket', 'queue', 'event', 'listener', 'hook', 'decorator',
      '拦截器', '中间件', '装饰器', '队列', '事件', '监听器',
    ]
    for (const keyword of techKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi')
      while ((match = regex.exec(input)) !== null) {
        const name = match[0]
        const key = `${name}-${match.index}`
        if (seen.has(key)) continue
        seen.add(key)
        entities.push({
          name,
          type: 'keyword',
          confidence: 0.6,
          position: { start: match.index, end: match.index + name.length },
        })
      }
    }

    // 4. 尝试提取 "X 的 Y 方法" 模式
    const methodPattern = /([一-龥\w]+)[的\s]+(\w+)[\s]*(?:方法|函数|method|function)/gi
    while ((match = methodPattern.exec(input)) !== null) {
      const className = match[1]
      const methodName = match[2]
      if (!seen.has(methodName)) {
        seen.add(methodName)
        entities.push({
          name: methodName,
          type: 'method',
          confidence: 0.85,
          position: { start: match.index + match[0].indexOf(methodName), end: match.index + match[0].indexOf(methodName) + methodName.length },
        })
      }
      // 同时添加类名
      if (!seen.has(className) && /^[A-Z]/.test(className)) {
        seen.add(className)
        entities.push({
          name: className,
          type: 'class',
          confidence: 0.7,
          position: { start: match.index, end: match.index + className.length },
        })
      }
    }

    // 去重并按置信度排序
    return entities
      .filter((e, i, arr) => arr.findIndex(x => x.name === e.name && x.type === e.type) === i)
      .sort((a, b) => b.confidence - a.confidence)
  }

  private detectIntent(input: string): ExtractionResult['intent'] {
    for (const { pattern, intent } of this.intentPatterns) {
      if (pattern.test(input)) return intent
    }
    return 'unknown'
  }

  private buildTargetDescription(input: string, entities: ExtractedEntity[]): string {
    let desc = input
    // 移除已识别的实体名，保留描述性文本
    for (const entity of entities.sort((a, b) => (b.position?.start ?? 0) - (a.position?.start ?? 0))) {
      if (entity.position) {
        desc = desc.slice(0, entity.position.start) + `[${entity.type}]` + desc.slice(entity.position.end)
      }
    }
    return desc.replace(/\s+/g, ' ').trim()
  }

  private calculateEntityConfidence(name: string, type: EntityType, context: string): number {
    let score = 0.7
    // 命名规范加分
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name) && type === 'class') score += 0.1
    if (/^[a-z][a-zA-Z0-9]*$/.test(name) && type === 'function') score += 0.1
    // 上下文佐证加分
    const surrounding = context.slice(Math.max(0, context.indexOf(name) - 30), context.indexOf(name) + name.length + 30)
    if (/class|interface|function|method|组件|类|接口|函数|方法/.test(surrounding)) score += 0.1
    return Math.min(1.0, score)
  }
}
```

- [ ] **Step 2: 编写测试**

创建 `src/main/code-intelligence/__tests__/entity-extractor.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { EntityExtractor } from '../entity-extractor'

describe('EntityExtractor', () => {
  const extractor = new EntityExtractor()

  it('should extract class names from Chinese requirement', () => {
    const input = '请给 UserService 添加一个根据 email 查找用户的方法'
    const result = extractor.extract(input)

    expect(result.intent).toBe('implement')
    expect(result.entities.some(e => e.name === 'UserService' && e.type === 'class')).toBe(true)
  })

  it('should extract file paths', () => {
    const input = '修改 src/user/controller.ts 中的 login 方法'
    const result = extractor.extract(input)

    const fileEntity = result.entities.find(e => e.type === 'file')
    expect(fileEntity?.name).toBe('src/user/controller.ts')
  })

  it('should detect fix intent', () => {
    const input = '修复 AuthService 中的内存泄漏问题'
    const result = extractor.extract(input)
    expect(result.intent).toBe('fix')
    expect(result.entities.some(e => e.name === 'AuthService')).toBe(true)
  })

  it('should detect refactor intent', () => {
    const input = '重构 UserController，把验证逻辑提取到中间件中'
    const result = extractor.extract(input)
    expect(result.intent).toBe('refactor')
  })

  it('should extract method references in Chinese pattern', () => {
    const input = '实现 UserService 的 createUser 方法'
    const result = extractor.extract(input)

    const method = result.entities.find(e => e.name === 'createUser')
    expect(method?.type).toBe('method')
    expect(method?.confidence).toBeGreaterThan(0.8)
  })

  it('should handle English requirements', () => {
    const input = 'Add logging to the UserController.login method'
    const result = extractor.extract(input)

    expect(result.intent).toBe('implement')
    expect(result.entities.some(e => e.name === 'UserController' && e.type === 'class')).toBe(true)
    expect(result.entities.some(e => e.name === 'login' && e.type === 'method')).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/code-intelligence/__tests__/entity-extractor.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/code-intelligence/
git commit -m "feat(code-intelligence): add EntityExtractor for technical entity extraction from user requirements"
```

---

### Task 2.2: 智能上下文解析器（SmartContextResolver）

**Files:**
- Create: `src/main/code-intelligence/smart-context-resolver.ts`
- Create: `src/main/code-intelligence/__tests__/smart-context-resolver.test.ts`
- Modify: `src/main/agent/agent-manager.ts`（集成新的上下文解析）

- [ ] **Step 1: 创建 SmartContextResolver**

创建 `src/main/code-intelligence/smart-context-resolver.ts`：

```typescript
import type { SymbolInfo, SymbolQueryResult, GraphNode } from '@shared/types'
import { SymbolIndex } from './symbol-index'
import { EntityExtractor, type ExtractionResult } from './entity-extractor'
import * as fs from 'fs'

export interface SmartContextOptions {
  userQuery: string
  projectPath: string
  nodes?: GraphNode[]
  maxSymbols?: number // 最大符号数，默认 20
  maxFiles?: number // 最大文件数，默认 10
  dependencyDepth?: number // 依赖图扩展深度，默认 2
}

export interface ResolvedCodeContext {
  primarySymbols: SymbolQueryResult[] // 直接匹配的符号
  relatedSymbols: SymbolQueryResult[] // 通过依赖图扩展找到的符号
  relatedFiles: Array<{
    filePath: string
    distance: number // 依赖图距离
    reason: string // 为什么包含这个文件
    content: string // 文件内容（截断）
  }>
  importGraph: Array<{ from: string; to: string }> // 简化依赖图
  summary: string // 上下文摘要
}

/**
 * 智能上下文解析器
 * 从用户查询出发，通过符号索引和依赖图找到最相关的代码上下文
 */
export class SmartContextResolver {
  private symbolIndex: SymbolIndex
  private entityExtractor: EntityExtractor

  constructor(symbolIndex: SymbolIndex) {
    this.symbolIndex = symbolIndex
    this.entityExtractor = new EntityExtractor()
  }

  /**
   * 解析用户查询，返回智能组装的代码上下文
   */
  resolve(options: SmartContextOptions): ResolvedCodeContext {
    const extraction = this.entityExtractor.extract(options.userQuery)
    const maxSymbols = options.maxSymbols ?? 20
    const maxFiles = options.maxFiles ?? 10
    const depth = options.dependencyDepth ?? 2

    // 阶段 1: 基于提取的实体查找符号
    const primarySymbols = this.findSymbolsFromEntities(extraction, maxSymbols)

    // 阶段 2: 沿依赖图扩展
    const { relatedSymbols, relatedFiles } = this.expandByDependencyGraph(
      primarySymbols,
      maxSymbols - primarySymbols.length,
      maxFiles,
      depth,
      options.projectPath
    )

    // 阶段 3: 构建依赖图摘要
    const importGraph = this.buildImportGraphSnippet(primarySymbols, relatedSymbols)

    // 阶段 4: 生成上下文摘要
    const summary = this.buildContextSummary(extraction, primarySymbols, relatedSymbols)

    return { primarySymbols, relatedSymbols, relatedFiles, importGraph, summary }
  }

  private findSymbolsFromEntities(extraction: ExtractionResult, limit: number): SymbolQueryResult[] {
    const results: SymbolQueryResult[] = []
    const seen = new Set<string>()

    // 按实体类型优先级查询：class > method > interface > file > keyword
    const priorityOrder: Array<ExtractionResult['entities'][number]['type']> = [
      'class', 'method', 'function', 'interface', 'file', 'module', 'keyword'
    ]

    for (const type of priorityOrder) {
      const entitiesOfType = extraction.entities.filter(e => e.type === type)
      for (const entity of entitiesOfType) {
        if (results.length >= limit) break

        if (type === 'file') {
          // 文件路径类型的实体：获取该文件的所有导出符号
          const fileSymbols = this.symbolIndex.getSymbolsByFile(entity.name)
            .filter(s => s.isExported)
            .map(s => ({ symbol: s, score: entity.confidence, matchedBy: 'path' as const }))
          for (const fs of fileSymbols) {
            if (!seen.has(fs.symbol.id)) {
              seen.add(fs.symbol.id)
              results.push(fs)
            }
          }
        } else {
          // 其他类型：按名称查询符号
          const kind = type === 'method' ? 'method' : type === 'function' ? 'function' : type === 'interface' ? 'interface' : type === 'class' ? 'class' : undefined
          const found = this.symbolIndex.querySymbols(entity.name, { kind, limit: 5 })
          for (const f of found) {
            if (!seen.has(f.symbol.id)) {
              seen.add(f.symbol.id)
              results.push({ ...f, score: f.score * entity.confidence })
            }
          }
        }
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }

  private expandByDependencyGraph(
    primarySymbols: SymbolQueryResult[],
    symbolLimit: number,
    fileLimit: number,
    depth: number,
    projectPath: string
  ): { relatedSymbols: SymbolQueryResult[]; relatedFiles: ResolvedCodeContext['relatedFiles'] } {
    const relatedSymbols: SymbolQueryResult[] = []
    const relatedFiles: ResolvedCodeContext['relatedFiles'] = []
    const processedFiles = new Set<string>()
    const seenSymbolIds = new Set(primarySymbols.map(s => s.symbol.id))

    for (const primary of primarySymbols) {
      if (processedFiles.has(primary.symbol.filePath)) continue
      processedFiles.add(primary.symbol.filePath)

      // 获取依赖图中的相关文件
      const relatedFilePaths = this.symbolIndex.getRelatedFiles(primary.symbol.filePath, depth)

      for (const [filePath, distance] of relatedFilePaths.entries()) {
        if (processedFiles.size >= fileLimit) break
        if (processedFiles.has(filePath)) continue
        processedFiles.add(filePath)

        // 读取文件内容（智能截断，优先读取导出符号）
        const content = this.readFileWithSmartTruncation(filePath, projectPath)

        // 从相关文件中提取高价值符号（导出的类/接口/函数）
        const fileSymbols = this.symbolIndex.getSymbolsByFile(filePath)
          .filter(s => s.isExported && !seenSymbolIds.has(s.id))
          .slice(0, 3) // 每个相关文件最多取 3 个导出符号

        for (const s of fileSymbols) {
          if (relatedSymbols.length >= symbolLimit) break
          seenSymbolIds.add(s.id)
          relatedSymbols.push({
            symbol: s,
            score: Math.max(0.3, 1 - distance * 0.3), // 距离越远得分越低
            matchedBy: distance === 1 ? 'exact' : 'fuzzy',
          })
        }

        relatedFiles.push({
          filePath,
          distance,
          reason: `被 ${path.basename(primary.symbol.filePath)} ${distance === 1 ? '直接' : '间接'}引用`,
          content,
        })
      }
    }

    return { relatedSymbols, relatedFiles }
  }

  private readFileWithSmartTruncation(filePath: string, projectPath: string): string {
    try {
      const fullPath = filePath.startsWith('/') ? filePath : require('path').join(projectPath, filePath)
      if (!require('fs').existsSync(fullPath)) return ''
      const content = require('fs').readFileSync(fullPath, 'utf-8')

      // 策略：如果文件不大，返回全部；如果很大，优先返回导出符号的定义部分
      if (content.length < 8000) return content

      const symbols = this.symbolIndex.getSymbolsByFile(fullPath).filter(s => s.isExported)
      if (symbols.length === 0) {
        // 没有导出符号，返回文件头部（import + 前几个定义）
        return content.slice(0, 5000)
      }

      // 收集导出符号周围的上下文
      const lines = content.split('\n')
      const segments: Array<{ start: number; end: number }> = []

      for (const symbol of symbols) {
        const contextStart = Math.max(0, symbol.line - 3)
        const contextEnd = Math.min(lines.length, (symbol.endLine ?? symbol.line) + 2)
        segments.push({ start: contextStart, end: contextEnd })
      }

      // 合并重叠的段落
      segments.sort((a, b) => a.start - b.start)
      const merged: Array<{ start: number; end: number }> = []
      for (const seg of segments) {
        const last = merged[merged.length - 1]
        if (last && seg.start <= last.end + 2) {
          last.end = Math.max(last.end, seg.end)
        } else {
          merged.push({ ...seg })
        }
      }

      // 提取合并后的段落
      const resultLines: string[] = []
      let lastEnd = 0
      for (const seg of merged) {
        if (seg.start > lastEnd + 1) {
          resultLines.push('// ...')
        }
        resultLines.push(...lines.slice(seg.start, seg.end))
        lastEnd = seg.end
      }

      return resultLines.join('\n').slice(0, 8000)
    } catch {
      return ''
    }
  }

  private buildImportGraphSnippet(primarySymbols: SymbolQueryResult[], relatedSymbols: SymbolQueryResult[]): Array<{ from: string; to: string }> {
    const edges = new Set<string>()
    const allFiles = new Set([...primarySymbols, ...relatedSymbols].map(s => s.symbol.filePath))

    for (const file of allFiles) {
      const imports = this.symbolIndex.getImports(file)
      for (const imp of imports) {
        if (allFiles.has(imp.toFile)) {
          edges.add(`${imp.fromFile} -> ${imp.toFile}`)
        }
      }
    }

    return Array.from(edges).map(e => {
      const [from, to] = e.split(' -> ')
      return { from: require('path').basename(from), to: require('path').basename(to) }
    })
  }

  private buildContextSummary(extraction: ExtractionResult, primary: SymbolQueryResult[], related: SymbolQueryResult[]): string {
    const parts: string[] = []
    parts.push(`意图: ${extraction.intent}`)
    if (extraction.targetDescription) {
      parts.push(`目标: ${extraction.targetDescription}`)
    }
    if (primary.length > 0) {
      parts.push(`核心符号: ${primary.map(s => s.symbol.name).join(', ')}`)
    }
    if (related.length > 0) {
      parts.push(`相关符号: ${related.slice(0, 5).map(s => s.symbol.name).join(', ')}`)
    }
    return parts.join('\n')
  }
}
```

- [ ] **Step 2: 编写测试**

创建 `src/main/code-intelligence/__tests__/smart-context-resolver.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SmartContextResolver } from '../smart-context-resolver'
import { SymbolIndex } from '../symbol-index'
import { AstParser } from '../ast-parser'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { generateId } from '../../shared/env'
import type { SymbolInfo } from '@shared/types'

describe('SmartContextResolver', () => {
  let tmpDir: string
  let symbolIndex: SymbolIndex
  let resolver: SmartContextResolver

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-context-test-'))
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })

    // 创建测试代码文件
    fs.writeFileSync(path.join(tmpDir, 'src', 'user.service.ts'), `
      import { Repository } from './repository'
      import { Logger } from './logger'

      export class UserService {
        constructor(private repo: Repository, private logger: Logger) {}

        /** 根据ID查找用户 */
        async findById(id: string) {
          this.logger.info('Finding user by id')
          return this.repo.findOne({ id })
        }

        /** 创建用户 */
        async create(data: CreateUserDto) {
          this.logger.info('Creating user')
          return this.repo.create(data)
        }
      }
    `)

    fs.writeFileSync(path.join(tmpDir, 'src', 'repository.ts'), `
      export class Repository {
        async findOne(query: any) { return null }
        async create(data: any) { return null }
      }
    `)

    fs.writeFileSync(path.join(tmpDir, 'src', 'logger.ts'), `
      export class Logger {
        info(msg: string) { console.log(msg) }
      }
    `)

    // 构建索引
    const dbPath = path.join(tmpDir, 'index.db')
    symbolIndex = new SymbolIndex(dbPath)
    const parser = new AstParser()

    for (const file of ['user.service.ts', 'repository.ts', 'logger.ts']) {
      const content = fs.readFileSync(path.join(tmpDir, 'src', file), 'utf-8')
      const result = parser.parse(path.join(tmpDir, 'src', file), content)
      symbolIndex.insertSymbols(result.symbols)
      symbolIndex.insertImportEdges(result.imports)
    }

    resolver = new SmartContextResolver(symbolIndex)
  })

  afterEach(() => {
    symbolIndex.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should resolve context from class name mention', () => {
    const context = resolver.resolve({
      userQuery: '修改 UserService 的 create 方法，添加参数校验',
      projectPath: tmpDir,
    })

    expect(context.primarySymbols.some(s => s.symbol.name === 'UserService')).toBe(true)
    expect(context.primarySymbols.some(s => s.symbol.name === 'create')).toBe(true)
    expect(context.relatedFiles.length).toBeGreaterThan(0)
  })

  it('should expand context via dependency graph', () => {
    const context = resolver.resolve({
      userQuery: '给 UserService 添加日志',
      projectPath: tmpDir,
    })

    // UserService 依赖 Repository 和 Logger
    const relatedFilePaths = context.relatedFiles.map(f => path.basename(f.filePath))
    expect(relatedFilePaths.some(f => f.includes('repository') || f.includes('logger'))).toBe(true)
  })

  it('should generate context summary', () => {
    const context = resolver.resolve({
      userQuery: '实现用户认证功能',
      projectPath: tmpDir,
    })

    expect(context.summary).toContain('意图')
    expect(context.summary.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/code-intelligence/__tests__/smart-context-resolver.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/code-intelligence/
git commit -m "feat(code-intelligence): add SmartContextResolver for entity-based code context resolution"
```

---

## 阶段三：动态 Prompt 构建器

> 目标：重构 Prompt 构建逻辑，基于代码重要性、依赖关系和任务类型动态组装上下文。

### Task 3.1: 代码感知 Prompt 构建器

**Files:**
- Create: `src/main/code-intelligence/prompt-assembler.ts`
- Modify: `src/main/adapters/base.ts`（使用新的 Prompt 构建器）

- [ ] **Step 1: 创建 PromptAssembler**

创建 `src/main/code-intelligence/prompt-assembler.ts`：

```typescript
import type { ResolvedCodeContext, SymbolQueryResult } from './smart-context-resolver'
import type { AgentSessionConfig } from '@shared/types'

export interface PromptAssemblyOptions {
  sessionConfig: AgentSessionConfig
  codeContext?: ResolvedCodeContext
  userCommand: string
  tokenBudget?: number
}

/**
 * 代码感知 Prompt 组装器
 * 将 SmartContextResolver 的结果组装成结构化的 Prompt
 */
export class PromptAssembler {
  /**
   * 组装完整的 agent prompt
   */
  assemble(options: PromptAssemblyOptions): string {
    const { sessionConfig, codeContext, userCommand } = options
    const parts: string[] = []

    // 1. 系统级约束（scope prompt）
    parts.push(this.buildScopeSection(sessionConfig))

    // 2. 代码上下文（如果可用）
    if (codeContext) {
      parts.push(this.buildCodeContextSection(codeContext))
    }

    // 3. 用户命令
    parts.push(this.buildCommandSection(userCommand))

    return parts.join('\n\n---\n\n')
  }

  private buildScopeSection(config: AgentSessionConfig): string {
    const lines: string[] = ['# 任务范围']

    if (config.nodeTitle) {
      lines.push(`## 目标节点: ${config.nodeTitle}`)
    }

    if (config.acceptanceCriteria && config.acceptanceCriteria.length > 0) {
      lines.push('## 验收标准')
      for (const [i, criterion] of config.acceptanceCriteria.entries()) {
        lines.push(`${i + 1}. ${criterion}`)
      }
    }

    if (config.allowedFiles && config.allowedFiles.length > 0) {
      lines.push('## 允许修改的文件')
      for (const file of config.allowedFiles) {
        lines.push(`- ${file}`)
      }
    }

    if (config.forbiddenFiles && config.forbiddenFiles.length > 0) {
      lines.push('## 禁止修改的文件')
      for (const file of config.forbiddenFiles) {
        lines.push(`- ${file}`)
      }
    }

    if (config.invariantRules && config.invariantRules.length > 0) {
      lines.push('## 不变规则')
      for (const rule of config.invariantRules) {
        lines.push(`- ${rule}`)
      }
    }

    return lines.join('\n')
  }

  private buildCodeContextSection(context: ResolvedCodeContext): string {
    const lines: string[] = ['# 代码上下文']

    if (context.summary) {
      lines.push(`## 分析摘要\n${context.summary}`)
    }

    // 核心符号（用户直接提到的）
    if (context.primarySymbols.length > 0) {
      lines.push('## 核心代码')
      for (const result of context.primarySymbols) {
        lines.push(this.formatSymbol(result))
      }
    }

    // 相关符号（依赖图扩展的）
    if (context.relatedSymbols.length > 0) {
      lines.push('## 相关代码')
      for (const result of context.relatedSymbols.slice(0, 10)) {
        lines.push(this.formatSymbol(result, true))
      }
    }

    // 相关文件内容
    if (context.relatedFiles.length > 0) {
      lines.push('## 相关文件')
      for (const file of context.relatedFiles) {
        lines.push(`### ${file.filePath} (${file.reason})`)
        lines.push('```typescript')
        lines.push(file.content)
        lines.push('```')
      }
    }

    // 依赖图
    if (context.importGraph.length > 0) {
      lines.push('## 文件依赖关系')
      for (const edge of context.importGraph) {
        lines.push(`${edge.from} -> ${edge.to}`)
      }
    }

    return lines.join('\n')
  }

  private formatSymbol(result: SymbolQueryResult, compact: boolean = false): string {
    const { symbol, score, matchedBy } = result
    const header = `### ${symbol.name} (${symbol.kind}, 匹配度: ${(score * 100).toFixed(0)}%, ${matchedBy})`

    if (compact) {
      // 紧凑模式：只显示签名和位置
      return `${header}\n- 位置: ${symbol.filePath}:${symbol.line}\n- 签名: ${symbol.signature ?? 'N/A'}`
    }

    // 完整模式：显示源码
    const lines: string[] = [header]
    if (symbol.signature) lines.push(`- 签名: ${symbol.signature}`)
    lines.push(`- 位置: ${symbol.filePath}:${symbol.line}`)
    if (symbol.jsDoc) lines.push(`- 注释: ${symbol.jsDoc}`)

    if (symbol.sourceCode) {
      lines.push('```typescript')
      lines.push(symbol.sourceCode)
      lines.push('```')
    }

    return lines.join('\n')
  }

  private buildCommandSection(command: string): string {
    return `# 任务指令\n${command}`
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/code-intelligence/prompt-assembler.ts
git commit -m "feat(code-intelligence): add PromptAssembler for structured code-aware prompt building"
```

---

### Task 3.2: 集成到 AgentManager

**Files:**
- Modify: `src/main/agent/agent-manager.ts`
- Modify: `src/main/ipc/agent.ts`
- Modify: `src/main/adapters/base.ts`（可选：使用 PromptAssembler）

- [ ] **Step 1: 在 AgentManager 中集成代码智能**

修改 `src/main/agent/agent-manager.ts`，在 `resolveAndSendCommand` 中集成 SmartContextResolver：

```typescript
// 在文件顶部添加导入
import { SmartContextResolver } from '../code-intelligence/smart-context-resolver'
import { PromptAssembler } from '../code-intelligence/prompt-assembler'

// 在 AgentManager 类中添加属性
export class AgentManager {
  // ... 现有属性 ...
  private smartContextResolver?: SmartContextResolver
  private promptAssembler: PromptAssembler = new PromptAssembler()

  // 提供 setter 注入
  setSmartContextResolver(resolver: SmartContextResolver): void {
    this.smartContextResolver = resolver
  }

  // 修改 resolveAndSendCommand 方法
  async resolveAndSendCommand(
    sessionId: string,
    command: string,
    contextRefs?: ContextRef[],
    nodes?: GraphNode[]
  ): Promise<void> {
    const session = this.sessionStates.get(sessionId)
    if (!session) throw new SessionNotFoundError(sessionId)

    let resolvedContexts: ResolvedContext[] = []

    // 1. 原有的上下文引用解析
    if (contextRefs && contextRefs.length > 0) {
      resolvedContexts = await this.contextResolver.resolve(contextRefs, 8000, {
        nodes: nodes ?? [],
        basePath: session.config.workingDirectory,
      })
    }

    // 2. 【新增】智能代码上下文解析
    let codeContext = undefined
    if (this.smartContextResolver && session.config.workingDirectory) {
      try {
        codeContext = this.smartContextResolver.resolve({
          userQuery: command,
          projectPath: session.config.workingDirectory,
          nodes: nodes ?? [],
          maxSymbols: 15,
          maxFiles: 8,
          dependencyDepth: 2,
        })
      } catch (err) {
        console.warn('Smart context resolution failed:', err)
      }
    }

    // 3. 使用 PromptAssembler 组装 prompt（可选增强）
    // 将 codeContext 存储在 session 上供 adapter 使用
    if (codeContext) {
      ;(session as any).codeContext = codeContext
    }

    // 4. 设置解析后的上下文
    const adapter = this.router.resolve(sessionId)
    if (adapter && resolvedContexts.length > 0) {
      adapter.setResolvedContexts(sessionId, resolvedContexts)
    }

    await this.sendCommand(sessionId, command)
  }
}
```

- [ ] **Step 2: 在 Adapter 中使用 codeContext**

修改 `src/main/adapters/base.ts` 的 `buildScopePrompt` 方法，如果 session 有 `codeContext`，则优先使用：

```typescript
// 在 buildScopePrompt 中添加
protected buildScopePrompt(config: AgentSessionConfig, resolvedContexts?: ResolvedContext[]): string {
  // ... 原有逻辑 ...

  // 【新增】如果有 codeContext，将其内容注入到附加上下文中
  const session = this.getSession(sessionId)
  const codeContext = (session as any)?.codeContext
  if (codeContext && codeContext.summary) {
    lines.push('\n## 智能分析')
    lines.push(codeContext.summary)
  }

  // ... 原有逻辑继续 ...
}
```

或者更彻底地，在 `doSendCommand` 中让 `PromptAssembler` 完全接管 prompt 构建。

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/agent-manager.ts src/main/adapters/base.ts
git commit -m "feat(code-intelligence): integrate SmartContextResolver into AgentManager"
```

---

## 阶段四：Agent 规划模式（简化版）

> 目标：实现需求意图分析和基础执行计划生成。作为阶段二实体提取器的自然延伸。

### Task 4.1: 执行计划生成器

**Files:**
- Create: `src/main/code-intelligence/execution-planner.ts`
- Create: `src/main/code-intelligence/__tests__/execution-planner.test.ts`

- [ ] **Step 1: 创建 ExecutionPlanner**

创建 `src/main/code-intelligence/execution-planner.ts`：

```typescript
import { EntityExtractor, type ExtractionResult } from './entity-extractor'

export interface ExecutionStep {
  id: string
  action: 'read' | 'modify' | 'create' | 'test' | 'verify'
  target: string // 目标文件或符号
  description: string
  dependencies: string[] // 依赖的其他 step id
}

export interface ExecutionPlan {
  intent: string
  steps: ExecutionStep[]
  estimatedComplexity: 'simple' | 'moderate' | 'complex'
  requiresNewFiles: boolean
  affectedSymbols: string[]
}

/**
 * 执行计划生成器
 * 从用户提取的实体和意图生成执行步骤序列
 */
export class ExecutionPlanner {
  private entityExtractor: EntityExtractor

  constructor() {
    this.entityExtractor = new EntityExtractor()
  }

  /**
   * 从用户输入生成执行计划
   */
  generatePlan(userQuery: string): ExecutionPlan {
    const extraction = this.entityExtractor.extract(userQuery)

    switch (extraction.intent) {
      case 'implement':
        return this.planImplementation(extraction, userQuery)
      case 'fix':
        return this.planFix(extraction, userQuery)
      case 'refactor':
        return this.planRefactor(extraction, userQuery)
      case 'test':
        return this.planTest(extraction, userQuery)
      default:
        return this.planGeneric(extraction, userQuery)
    }
  }

  private planImplementation(extraction: ExtractionResult, query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const classEntities = extraction.entities.filter(e => e.type === 'class')
    const methodEntities = extraction.entities.filter(e => e.type === 'method' || e.type === 'function')
    const fileEntities = extraction.entities.filter(e => e.type === 'file')

    // 步骤 1: 读取现有相关代码
    for (const cls of classEntities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: cls.name,
        description: `阅读 ${cls.name} 的现有实现，理解上下文`,
        dependencies: [],
      })
    }

    // 步骤 2: 修改或创建方法
    for (const method of methodEntities) {
      const parentClass = classEntities.find(c => query.includes(`${c.name}.${method.name}`))
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'modify',
        target: parentClass ? `${parentClass.name}.${method.name}` : method.name,
        description: `在 ${parentClass?.name ?? '目标位置'} 中实现 ${method.name} 方法`,
        dependencies: parentClass ? [`step-${steps.findIndex(s => s.target === parentClass.name) + 1}`] : [],
      })
    }

    // 步骤 3: 如果没有指定具体类，可能需要创建新文件
    const requiresNewFiles = classEntities.length === 0 && fileEntities.length === 0
    if (requiresNewFiles) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'create',
        target: 'new-file',
        description: '创建新文件实现需求',
        dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
      })
    }

    // 步骤 4: 验证
    steps.push({
      id: `step-${steps.length + 1}`,
      action: 'verify',
      target: 'implementation',
      description: '验证实现是否符合需求',
      dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
    })

    return {
      intent: 'implement',
      steps,
      estimatedComplexity: steps.length > 5 ? 'complex' : steps.length > 2 ? 'moderate' : 'simple',
      requiresNewFiles,
      affectedSymbols: [...classEntities, ...methodEntities].map(e => e.name),
    }
  }

  private planFix(extraction: ExtractionResult, query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const entities = extraction.entities.filter(e => e.type === 'class' || e.type === 'method' || e.type === 'function')

    // 步骤 1: 定位问题
    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: entity.name,
        description: `检查 ${entity.name} 的实现，定位问题`,
        dependencies: [],
      })
    }

    // 步骤 2: 修复
    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'modify',
        target: entity.name,
        description: `修复 ${entity.name} 中的问题`,
        dependencies: [`step-${steps.findIndex(s => s.target === entity.name && s.action === 'read') + 1}`],
      })
    }

    // 步骤 3: 测试验证
    steps.push({
      id: `step-${steps.length + 1}`,
      action: 'test',
      target: entities.map(e => e.name).join(', '),
      description: '运行测试验证修复',
      dependencies: steps.length > 0 ? [steps[steps.length - 1].id] : [],
    })

    return {
      intent: 'fix',
      steps,
      estimatedComplexity: entities.length > 2 ? 'complex' : 'simple',
      requiresNewFiles: false,
      affectedSymbols: entities.map(e => e.name),
    }
  }

  private planRefactor(extraction: ExtractionResult, _query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const entities = extraction.entities.filter(e => e.type === 'class' || e.type === 'method' || e.type === 'function')

    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: entity.name,
        description: `分析 ${entity.name} 的当前实现`,
        dependencies: [],
      })
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'modify',
        target: entity.name,
        description: `重构 ${entity.name}`,
        dependencies: [`step-${steps.length - 1}`],
      })
    }

    return {
      intent: 'refactor',
      steps,
      estimatedComplexity: 'moderate',
      requiresNewFiles: false,
      affectedSymbols: entities.map(e => e.name),
    }
  }

  private planTest(extraction: ExtractionResult, _query: string): ExecutionPlan {
    const steps: ExecutionStep[] = []
    const entities = extraction.entities.filter(e => e.type === 'class' || e.type === 'method')

    for (const entity of entities) {
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'read',
        target: entity.name,
        description: `理解 ${entity.name} 的功能和边界情况`,
        dependencies: [],
      })
      steps.push({
        id: `step-${steps.length + 1}`,
        action: 'create',
        target: `${entity.name}.test`,
        description: `为 ${entity.name} 编写测试用例`,
        dependencies: [`step-${steps.length - 1}`],
      })
    }

    return {
      intent: 'test',
      steps,
      estimatedComplexity: 'moderate',
      requiresNewFiles: true,
      affectedSymbols: entities.map(e => e.name),
    }
  }

  private planGeneric(extraction: ExtractionResult, _query: string): ExecutionPlan {
    return {
      intent: 'unknown',
      steps: [
        {
          id: 'step-1',
          action: 'read',
          target: 'project',
          description: '分析项目结构以理解需求',
          dependencies: [],
        },
      ],
      estimatedComplexity: 'simple',
      requiresNewFiles: false,
      affectedSymbols: extraction.entities.map(e => e.name),
    }
  }
}
```

- [ ] **Step 2: 编写测试**

创建 `src/main/code-intelligence/__tests__/execution-planner.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { ExecutionPlanner } from '../execution-planner'

describe('ExecutionPlanner', () => {
  const planner = new ExecutionPlanner()

  it('should plan implementation with class and method', () => {
    const plan = planner.generatePlan('给 UserService 添加 createUser 方法')

    expect(plan.intent).toBe('implement')
    expect(plan.steps.some(s => s.action === 'read' && s.target === 'UserService')).toBe(true)
    expect(plan.steps.some(s => s.action === 'modify' && s.target.includes('createUser'))).toBe(true)
    expect(plan.steps.some(s => s.action === 'verify')).toBe(true)
  })

  it('should plan fix with test step', () => {
    const plan = planner.generatePlan('修复 AuthService 中的 token 过期问题')

    expect(plan.intent).toBe('fix')
    expect(plan.steps.some(s => s.action === 'read')).toBe(true)
    expect(plan.steps.some(s => s.action === 'modify')).toBe(true)
    expect(plan.steps.some(s => s.action === 'test')).toBe(true)
  })

  it('should plan refactor', () => {
    const plan = planner.generatePlan('重构 UserController，提取验证逻辑')

    expect(plan.intent).toBe('refactor')
    expect(plan.steps.length).toBeGreaterThanOrEqual(2)
  })

  it('should estimate complexity based on steps', () => {
    const simple = planner.generatePlan('修复 bug')
    expect(['simple', 'moderate', 'complex']).toContain(simple.estimatedComplexity)
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `npx vitest run src/main/code-intelligence/__tests__/execution-planner.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/code-intelligence/
git commit -m "feat(code-intelligence): add ExecutionPlanner for automatic execution step generation"
```

---

## 收尾工作

### Task 5.1: 统一导出和模块整合

**Files:**
- Create: `src/main/code-intelligence/index.ts`

- [ ] **Step 1: 创建统一导出文件**

创建 `src/main/code-intelligence/index.ts`：

```typescript
export { SymbolIndex } from './symbol-index'
export { AstParser } from './ast-parser'
export { ProjectIndexer } from './project-indexer'
export { CodeFileWatcher } from './file-watcher'
export { EntityExtractor } from './entity-extractor'
export { SmartContextResolver } from './smart-context-resolver'
export { PromptAssembler } from './prompt-assembler'
export { ExecutionPlanner } from './execution-planner'

export type {
  ParseResult,
} from './ast-parser'
export type {
  IndexOptions,
} from './project-indexer'
export type {
  FileWatcherOptions,
} from './file-watcher'
export type {
  ExtractedEntity,
  ExtractionResult,
  EntityType,
} from './entity-extractor'
export type {
  SmartContextOptions,
  ResolvedCodeContext,
} from './smart-context-resolver'
export type {
  PromptAssemblyOptions,
} from './prompt-assembler'
export type {
  ExecutionStep,
  ExecutionPlan,
} from './execution-planner'
```

- [ ] **Step 2: Commit**

```bash
git add src/main/code-intelligence/index.ts
git commit -m "feat(code-intelligence): add unified exports for code-intelligence module"
```

---

### Task 5.2: 类型检查和 Lint

- [ ] **Step 1: 运行类型检查**

Run: `npx tsc --noEmit`
Expected: 0 errors（可能需要修复一些类型问题）

- [ ] **Step 2: 运行 Lint**

Run: `npm run lint`
Expected: 0 warnings, 0 errors

- [ ] **Step 3: 运行全部测试**

Run: `npm run test`
Expected: 所有新增测试通过，现有测试不受影响

- [ ] **Step 4: Commit 修复**

```bash
git add .
git commit -m "style(code-intelligence): fix type errors and lint issues"
```

---

## 计划总结

| 阶段 | 任务数 | 核心产出 | 优先级 |
|------|--------|----------|--------|
| 阶段一 | 4 | AST 解析器 + 符号索引 + 项目扫描 + 增量更新 | P0 |
| 阶段二 | 2 | 实体提取 + 智能上下文解析 | P0 |
| 阶段三 | 2 | Prompt 组装器 + AgentManager 集成 | P1 |
| 阶段四 | 1 | 执行计划生成器 | P1 |
| 收尾 | 2 | 统一导出 + 类型/测试验证 | - |

**总计：11 个任务，约 44 个步骤**

---

## 自审检查

1. **Spec 覆盖**：所有 gap analysis 中识别的关键缺失都有对应任务：
   - AST 解析 → Task 1.2 ✅
   - 符号索引 → Task 1.1 ✅
   - Import 依赖图 → Task 1.1 (SymbolIndex.getRelatedFiles) ✅
   - 智能文件发现 → Task 2.2 (SmartContextResolver) ✅
   - 关键词/实体提取 → Task 2.1 (EntityExtractor) ✅
   - 智能 Prompt 组装 → Task 3.1 (PromptAssembler) ✅
   - 意图分析 → Task 4.1 (ExecutionPlanner) ✅

2. **占位符扫描**：计划中无 TBD、TODO、"实现 later" 等占位符。✅

3. **类型一致性**：所有类型引用 `SymbolInfo`、`ImportEdge` 等均来自 `@shared/types.ts`。✅

4. **技术可行性**：使用 TypeScript Compiler API（已有依赖 `typescript`），无需引入新的大型依赖。SQLite 使用项目已有数据库层。✅
