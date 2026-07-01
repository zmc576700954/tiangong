/**
 * TypeScript AST 解析器
 * 解析单个 .ts/.tsx/.js/.jsx 文件，提取符号定义和 import 关系
 */

import * as ts from 'typescript'
import path from 'node:path'
import * as fs from 'node:fs'
import type { SymbolInfo, ImportEdge } from '@shared/types'
import { generateId } from '../shared/env'
import { createLogger } from '../shared/logger'

const logger = createLogger('ast-parser')

export interface ParseResult {
  symbols: SymbolInfo[]
  imports: ImportEdge[]
  exports: string[] // 导出的符号名列表
}

export class AstParser {
  private compilerOptions: ts.CompilerOptions
  /** 路径别名映射，目标为绝对路径，如 { '@shared': '/proj/src/shared' } */
  private aliasMap: Map<string, string>

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
    // 从 compilerOptions.paths 提取路径别名映射
    this.aliasMap = new Map()
    if (this.compilerOptions.paths && this.compilerOptions.baseUrl) {
      const baseUrl = this.compilerOptions.baseUrl
      for (const [alias, targets] of Object.entries(this.compilerOptions.paths)) {
        if (Array.isArray(targets) && targets.length > 0) {
          // 将 `@shared/*` 转换为 `@shared`
          const aliasKey = alias.replace(/\/\*$/, '')
          const targetDir = targets[0].replace(/\/\*$/, '')
          // 目标相对 baseUrl，归一为绝对路径，确保与符号存储用的绝对 filePath 可比对
          this.aliasMap.set(aliasKey, path.resolve(baseUrl, targetDir))
        }
      }
    }
  }

  /** 候选源码扩展名，用于把无扩展名的模块说明符解析为磁盘真实文件 */
  private static readonly RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

  /**
   * basePath → resolved file path 的解析结果缓存。
   * 一次完整索引会对同一模块路径（如 '@shared/types' 展开后的绝对路径）解析数百次，
   * 缓存可将 ~13 次 synchronous statSync 扇出压缩为 O(1) Map 查找。
   * Map<null> 表示解析失败（无匹配文件），避免对不存在的路径重复扫描。
   *
   * 失效策略：
   * - clearResolveCache()：全量重索引前调用，清除全部陈旧条目。
   * - invalidateResolveCacheForFile()：增量重索引删除文件时调用，
   *   清除指向该文件的条目，防止留下幽灵依赖边。
   */
  private resolveCache = new Map<string, string | null>()

  /**
   * 把一个无扩展名的基路径解析为磁盘上的真实文件：
   * 依次尝试 base.<ext> 与 base/index.<ext>。命中则返回绝对文件路径，否则返回 null。
   * 结果被缓存，同一路径的后续调用直接返回而不访问文件系统。
   */
  /**
   * 清除全部解析结果缓存。在全量重索引（indexProject）开始前调用，
   * 确保上一次增量更新遗留的陈旧条目不污染新的索引结果。
   */
  clearResolveCache(): void {
    this.resolveCache.clear()
  }

  /**
   * 清除指向指定文件的所有缓存条目。
   * 在增量重索引删除文件前调用（_doReindexFile），防止其他文件对该文件的
   * 导入仍命中已失效的缓存，从而留下幽灵依赖边。
   */
  invalidateResolveCacheForFile(deletedFilePath: string): void {
    for (const [key, value] of this.resolveCache) {
      if (value === deletedFilePath) {
        this.resolveCache.delete(key)
      }
    }
  }

  private resolveModuleFile(basePath: string): string | null {
    const cached = this.resolveCache.get(basePath)
    if (cached !== undefined) return cached   // null 表示之前已解析为"不存在"

    const result = this._resolveModuleFileUncached(basePath)
    this.resolveCache.set(basePath, result)
    return result
  }

  private _resolveModuleFileUncached(basePath: string): string | null {
    // 说明符已带扩展名且文件存在（如 './foo.js'）
    try {
      if (fs.statSync(basePath).isFile()) return basePath
    } catch {
      // 不是直接文件，继续尝试补扩展名
    }
    for (const ext of AstParser.RESOLVE_EXTENSIONS) {
      const candidate = basePath + ext
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // 继续尝试下一个候选
      }
    }
    for (const ext of AstParser.RESOLVE_EXTENSIONS) {
      const candidate = path.join(basePath, 'index' + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        // 继续尝试下一个候选
      }
    }
    return null
  }

  /**
   * 解析文件内容，返回符号和 import 关系
   * 支持 .vue SFC 文件，自动提取 <script> 部分递归解析
   * 解析失败时回退到 _minimalExtract
   */
  parse(filePath: string, sourceCode: string): ParseResult {
    // Vue SFC 支持：提取 <script> 部分后递归解析
    if (filePath.endsWith('.vue')) {
      return this._parseVueSfc(filePath, sourceCode)
    }

    try {
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
          const importEdge = this.extractImport(node, filePath)
          if (importEdge) imports.push(importEdge)
        }

        // 如果当前节点创建了新的父作用域（如 class），将其 id 传给子节点
        const childParentId = symbol?.id ?? parentId
        ts.forEachChild(node, (child) => visit(child, childParentId))
      }

      visit(sourceFile)

      return { symbols, imports, exports }
    } catch (err) {
      logger.warn('AST parse failed, falling back to minimal extract:', filePath, err)
      return this._minimalExtract(filePath, sourceCode)
    }
  }

  /**
   * 解析 Vue SFC 文件：用正则提取 <script> 内容，检测 lang 后递归调用 parse()
   */
  private _parseVueSfc(filePath: string, sourceCode: string): ParseResult {
    const empty: ParseResult = { symbols: [], imports: [], exports: [] }

    // 提取 <script> 或 <script lang="ts"> 内容
    const scriptMatch = sourceCode.match(/<script[^>]*>([\s\S]*?)<\/script>/)
    if (!scriptMatch) {
      return empty
    }

    const scriptContent = scriptMatch[1]
    const scriptTag = scriptMatch[0]

    // 检测 lang 属性
    const langMatch = scriptTag.match(/lang=["'](\w+)["']/)
    const lang = langMatch?.[1] ?? 'js'

    // 根据语言确定虚拟文件路径
    let virtualPath = filePath
    if (lang === 'ts' || lang === 'tsx') {
      virtualPath = filePath + '.' + lang
    } else {
      virtualPath = filePath + '.js'
    }

    try {
      return this.parse(virtualPath, scriptContent)
    } catch (err) {
      logger.warn('Vue SFC parse failed, falling back to minimal extract:', filePath, err)
      return this._minimalExtract(virtualPath, scriptContent)
    }
  }

  /**
   * 最小化提取：仅提取文件级导出声明（export default）
   * 以及 Go/Rust/Java/SQL 声明，作为 AST 解析失败时的兜底方案
   */
  private _minimalExtract(filePath: string, sourceCode: string): ParseResult {
    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const ext = filePath.substring(filePath.lastIndexOf('.') + 1).toLowerCase()

    // Language-specific regex fallback for non-TS files
    if (ext === 'go') {
      return this._regexExtractGo(filePath, sourceCode)
    } else if (ext === 'rs') {
      return this._regexExtractRust(filePath, sourceCode)
    } else if (ext === 'java' || ext === 'kt') {
      return this._regexExtractJava(filePath, sourceCode)
    } else if (ext === 'sql') {
      return this._regexExtractSql(filePath, sourceCode)
    }

    // TS/JS fallback: 检测 export default 语句
    const exportDefaultMatch = sourceCode.match(
      /export\s+default\s+(?:function\s+(\w+)|class\s+(\w+)|(\w+))/
    )
    if (exportDefaultMatch) {
      const name = exportDefaultMatch[1] ?? exportDefaultMatch[2] ?? exportDefaultMatch[3]
      if (name) {
        const kind = exportDefaultMatch[1] ? 'function' : exportDefaultMatch[2] ? 'class' : 'variable'
        const line = sourceCode.substring(0, sourceCode.indexOf('export default')).split('\n').length
        symbols.push({
          id: generateId('symbol'),
          name,
          kind: kind as SymbolInfo['kind'],
          filePath,
          line,
          column: 0,
          isExported: true,
        })
        exports.push(name)
      }
    }

    return { symbols, imports, exports }
  }

  /** Go regex fallback: func, type struct, type interface, var, const */
  private _regexExtractGo(filePath: string, sourceCode: string): ParseResult {
    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const patterns: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }> = [
      { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm, kind: 'function' },
      { regex: /^type\s+(\w+)\s+struct\b/gm, kind: 'class' },
      { regex: /^type\s+(\w+)\s+interface\b/gm, kind: 'interface' },
      { regex: /^var\s+(\w+)/gm, kind: 'variable' },
      { regex: /^const\s+(\w+)/gm, kind: 'variable' },
    ]

    for (const { regex, kind } of patterns) {
      let match: RegExpExecArray | null
      while ((match = regex.exec(sourceCode)) !== null) {
        const name = match[1]
        const line = sourceCode.substring(0, match.index).split('\n').length
        const isExported = /^[A-Z]/.test(name) // Go: uppercase = exported
        symbols.push({ id: generateId('symbol'), name, kind, filePath, line, column: 0, isExported })
        if (isExported) exports.push(name)
      }
    }

    // Go imports
    const importMatch = sourceCode.match(/import\s+(?:\([\s\S]*?\)|"([^"]+)")/g)
    if (importMatch) {
      for (const imp of importMatch) {
        const paths = imp.match(/"([^"]+)"/g)
        if (paths) {
          for (const p of paths) {
            const toFile = p.replace(/"/g, '')
            imports.push({ fromFile: filePath, toFile, importedNames: [], isDefaultImport: false, line: 1 })
          }
        }
      }
    }

    return { symbols, imports, exports }
  }

  /** Rust regex fallback: fn, struct, enum, impl, trait, mod */
  private _regexExtractRust(filePath: string, sourceCode: string): ParseResult {
    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const patterns: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }> = [
      { regex: /^(?:pub\s+)?fn\s+(\w+)/gm, kind: 'function' },
      { regex: /^(?:pub\s+)?struct\s+(\w+)/gm, kind: 'class' },
      { regex: /^(?:pub\s+)?enum\s+(\w+)/gm, kind: 'enum' },
      { regex: /^(?:pub\s+)?impl\s+(?:\w+\s+for\s+)?(\w+)/gm, kind: 'class' },
      { regex: /^(?:pub\s+)?trait\s+(\w+)/gm, kind: 'interface' },
      { regex: /^(?:pub\s+)?mod\s+(\w+)/gm, kind: 'namespace' },
    ]

    for (const { regex, kind } of patterns) {
      let match: RegExpExecArray | null
      while ((match = regex.exec(sourceCode)) !== null) {
        const name = match[1]
        const line = sourceCode.substring(0, match.index).split('\n').length
        const isExported = match[0].startsWith('pub')
        symbols.push({ id: generateId('symbol'), name, kind, filePath, line, column: 0, isExported })
        if (isExported) exports.push(name)
      }
    }

    return { symbols, imports, exports }
  }

  /** Java/Kotlin regex fallback: class, interface, enum, method */
  private _regexExtractJava(filePath: string, sourceCode: string): ParseResult {
    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const patterns: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }> = [
      { regex: /(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?class\s+(\w+)/g, kind: 'class' },
      { regex: /(?:public|protected|private)?\s*(?:static\s+)?interface\s+(\w+)/g, kind: 'interface' },
      { regex: /(?:public|protected|private)?\s*(?:static\s+)?enum\s+(\w+)/g, kind: 'enum' },
      { regex: /(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g, kind: 'method' },
    ]

    for (const { regex, kind } of patterns) {
      let match: RegExpExecArray | null
      while ((match = regex.exec(sourceCode)) !== null) {
        const name = match[1]
        const line = sourceCode.substring(0, match.index).split('\n').length
        const isExported = /public/.test(match[0])
        symbols.push({ id: generateId('symbol'), name, kind, filePath, line, column: 0, isExported })
        if (isExported) exports.push(name)
      }
    }

    // Java imports
    const importRegex = /^import\s+(?:static\s+)?([^;]+);/gm
    let importMatch: RegExpExecArray | null
    while ((importMatch = importRegex.exec(sourceCode)) !== null) {
      const toFile = importMatch[1].trim()
      const line = sourceCode.substring(0, importMatch.index).split('\n').length
      imports.push({ fromFile: filePath, toFile, importedNames: [], isDefaultImport: false, line })
    }

    return { symbols, imports, exports }
  }

  /** SQL regex fallback: CREATE TABLE/INDEX/VIEW, functions */
  private _regexExtractSql(filePath: string, sourceCode: string): ParseResult {
    const symbols: SymbolInfo[] = []
    const imports: ImportEdge[] = []
    const exports: string[] = []

    const patterns: Array<{ regex: RegExp; kind: SymbolInfo['kind'] }> = [
      { regex: /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi, kind: 'class' },
      { regex: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi, kind: 'variable' },
      { regex: /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi, kind: 'interface' },
      { regex: /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(\w+)/gi, kind: 'function' },
    ]

    for (const { regex, kind } of patterns) {
      let match: RegExpExecArray | null
      while ((match = regex.exec(sourceCode)) !== null) {
        const name = match[1]
        const line = sourceCode.substring(0, match.index).split('\n').length
        symbols.push({ id: generateId('symbol'), name, kind, filePath, line, column: 0, isExported: true })
        exports.push(name)
      }
    }

    return { symbols, imports, exports }
  }

  private extractSymbol(node: ts.Node, filePath: string, _sourceCode: string, parentId?: string): SymbolInfo | null {
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
    } else if (ts.isConstructorDeclaration(node)) {
      kind = 'method'
      name = 'constructor'
      isExported = false
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
    } else if (ts.isModuleDeclaration(node)) {
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

    const signature = this.extractSignature(node)
    const jsDoc = this.extractJsDoc(node)

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

  private extractImport(node: ts.ImportDeclaration, filePath: string): ImportEdge | null {
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

    // 将相对路径/别名解析为磁盘上的真实文件（含扩展名 + index 解析），
    // 使 toFile 与符号存储用的绝对 filePath 一致，依赖图查询才能命中。
    let resolvedPath = moduleSpecifier // 默认保留原样（外部模块/裸包名）
    let basePath: string | null = null
    if (moduleSpecifier.startsWith('.')) {
      basePath = path.resolve(path.dirname(filePath), moduleSpecifier)
    } else {
      // 尝试匹配路径别名（如 @shared/types → <baseUrl>/shared/types）
      for (const [alias, targetDir] of this.aliasMap) {
        if (moduleSpecifier === alias) {
          basePath = targetDir
          break
        }
        if (moduleSpecifier.startsWith(alias + '/')) {
          basePath = path.join(targetDir, moduleSpecifier.slice(alias.length + 1))
          break
        }
      }
    }

    if (basePath !== null) {
      // 已带扩展名且存在则直接用；否则尝试补扩展名 / index 文件；都失败则回退到 basePath
      const resolved = this.resolveModuleFile(basePath) ?? basePath
      resolvedPath = path.normalize(resolved)
    }

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
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
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

  private extractSignature(node: ts.Node): string | undefined {
    // 提取函数/方法签名文本
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const params = node.parameters.map((p) => p.getText()).join(', ')
      const returnType = node.type ? `: ${node.type.getText()}` : ''
      return `${node.name?.getText() ?? 'anonymous'}(${params})${returnType}`
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const heritage = node.heritageClauses?.map((h) => h.getText()).join(' ')
      return `class ${node.name.text} ${heritage ?? ''}`.trim()
    }
    if (ts.isInterfaceDeclaration(node)) {
      const heritage = node.heritageClauses?.map((h) => h.getText()).join(' ')
      return `interface ${node.name.text} ${heritage ?? ''}`.trim()
    }
    return undefined
  }

  private extractJsDoc(node: ts.Node): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsDoc = (node as any).jsDoc as ts.JSDoc[] | undefined
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
    if (filePath.endsWith('.json')) return ts.ScriptKind.JSON
    return ts.ScriptKind.Unknown
  }
}
