/**
 * 项目级代码索引器
 * 扫描项目中的所有源码文件，解析 AST，构建符号索引和依赖图
 */

import * as fsSync from 'node:fs'
import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import * as ts from 'typescript'
import { AstParser } from './ast-parser'
import { type SymbolIndex } from './symbol-index'
import { getAstCache } from './ast-cache'
import type { SymbolInfo, ImportEdge } from '@shared/types'

export interface IndexOptions {
  projectPath: string
  includePatterns?: string[] // 默认: ['src/**/*.{ts,tsx,js,jsx}']
  excludePatterns?: string[] // 默认: ['node_modules', 'dist', '.git']
  tsConfigPath?: string // tsconfig.json 路径
}

export interface CodeChunk {
  filePath: string
  startLine: number
  endLine: number
  kind: string  // 'function' | 'class' | 'interface' | 'method' | 'module'
  name: string
  content: string
}

/**
 * 项目级代码索引器
 * 扫描项目中的所有源码文件，解析 AST，构建符号索引和依赖图
 */
export class ProjectIndexer {
  private astParser: AstParser
  private symbolIndex: SymbolIndex

  /** 单文件大小上限（字节）。超过则跳过解析，避免压缩/打包产物撑爆内存与 DB */
  private static readonly MAX_FILE_SIZE_BYTES = 1_000_000

  /** 每个文件正在进行的 reindex Promise，串行化同一文件的并发重索引，避免 clearFile/insert 交错 */
  private reindexInFlight = new Map<string, Promise<{ symbolsFound: number; importsFound: number }>>()

  constructor(symbolIndex: SymbolIndex, tsConfigPath?: string) {
    this.symbolIndex = symbolIndex
    let compilerOptions: ts.CompilerOptions | undefined
    if (tsConfigPath && fsSync.existsSync(tsConfigPath)) {
      const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile)
      if (!configFile.error) {
        const parsed = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
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
  async indexProject(
    options: IndexOptions
  ): Promise<{ filesIndexed: number; symbolsFound: number; importsFound: number }> {
    const include = options.includePatterns ?? ['**/*.{ts,tsx,js,jsx}']
    const exclude = options.excludePatterns ?? ['node_modules/**', 'dist/**', '.git/**', 'build/**', '.next/**']

    // Clear the AstParser module-resolution cache before a full reindex so that
    // stale entries left by prior incremental updates do not produce ghost import edges.
    this.astParser.clearResolveCache()

    // 收集所有匹配的文件
    const files = await this.collectFiles(options.projectPath, include, exclude)

    let symbolsFound = 0
    let importsFound = 0
    const allSymbols: SymbolInfo[] = []
    const allEdges: ImportEdge[] = []

    // 解析每个文件：先累计符号/边，最后批量插入，避免每个文件都触发 DB 往返
    for (const filePath of files) {
      try {
        // 跳过超大文件（打包/压缩产物），避免深层 AST 与重复 sourceCode 撑爆内存/DB
        try {
          const stat = await fsSync.promises.stat(filePath)
          if (stat.size > ProjectIndexer.MAX_FILE_SIZE_BYTES) continue
        } catch {
          // stat 失败则继续尝试读取（可能是权限/竞态），由下方 readFile 兜底
        }
        const content = await readFile(filePath, 'utf-8')
        const result = this.astParser.parse(filePath, content)

        allSymbols.push(...result.symbols)
        allEdges.push(...result.imports)

        symbolsFound += result.symbols.length
        importsFound += result.imports.length
      } catch (err) {
        console.warn(`Failed to parse ${filePath}:`, err)
      }
    }

    if (allSymbols.length > 0) {
      await this.symbolIndex.insertSymbols(allSymbols)
    }
    if (allEdges.length > 0) {
      await this.symbolIndex.insertImportEdges(allEdges)
    }

    return { filesIndexed: files.length, symbolsFound, importsFound }
  }

  /**
   * 增量更新：重新索引单个文件
   * 串行化同一文件的并发调用：若上一次 reindex 仍在进行（其 await 可能长于 file-watcher 的
   * debounce 窗口），新调用排队等待，避免两次 clearFile/insert 交错产生陈旧或重复行。
   */
  async reindexFile(filePath: string): Promise<{ symbolsFound: number; importsFound: number }> {
    const prev = this.reindexInFlight.get(filePath)
    // 串行化链：等待上一次 run settle 后再执行本次。用 .catch(() => undefined) 容错上一次的
    // rejection，确保即便 _doReindexFile 抛出异常，rejected Promise 也不会传播到下一个调用方
    // 的等待链上造成永久阻塞。_doReindexFile 内部所有异步路径都经 await，正常情况下必然 settle；
    // 此处再加一层保底，使本 Promise 链路始终能 resolve，不会永久占用 reindexInFlight 的 key。
    const run = (prev ? prev.catch(() => undefined) : Promise.resolve()).then(
      () => this._doReindexFile(filePath),
      // _doReindexFile 的异常由下方 try/await 重新抛给调用方；此处 catch 保证链路 settle
    ).then(
      (r) => r,
      () => ({ symbolsFound: 0, importsFound: 0 }) as { symbolsFound: number; importsFound: number },
    )
    this.reindexInFlight.set(filePath, run)
    try {
      return await run
    } finally {
      // 仅当当前 run 仍是最新登记的 Promise 时才清理，避免误删后续排队的条目
      if (this.reindexInFlight.get(filePath) === run) {
        this.reindexInFlight.delete(filePath)
      }
    }
  }

  private async _doReindexFile(filePath: string): Promise<{ symbolsFound: number; importsFound: number }> {
    // Invalidate resolve cache entries that pointed to this file before clearing
    // the symbol index, so stale ghost import edges are not left behind if this
    // file was deleted (the importer is not re-indexed in that case).
    this.astParser.invalidateResolveCacheForFile(filePath)
    await this.symbolIndex.clearFile(filePath)

    // Check AstCache for mtime-matched results before parsing
    let result
    const cache = getAstCache()
    try {
      const stat = fsSync.statSync(filePath)
      const cached = cache.get(filePath, stat.mtimeMs)
      if (cached) {
        result = cached
      }
    } catch {
      // stat failed (file may be deleted), fall through to parse
    }

    if (!result) {
      const content = await readFile(filePath, 'utf-8')
      result = this.astParser.parse(filePath, content)
      // Store in cache for future use
      try {
        const stat = fsSync.statSync(filePath)
        cache.set(filePath, stat.mtimeMs, result)
      } catch {
        // stat failed, skip caching
      }
    }

    await this.symbolIndex.insertSymbols(result.symbols)
    await this.symbolIndex.insertImportEdges(result.imports)
    return { symbolsFound: result.symbols.length, importsFound: result.imports.length }
  }

  /**
   * 语义分块：基于 AST 符号边界将文件拆分为 CodeChunk
   * 每个符号对应一个 chunk，endLine 由下一个符号的 startLine 或文件末尾决定
   * 无符号时回退为每 50 行一个 chunk；完全无内容时返回一个 module 级 chunk
   */
  chunkFile(filePath: string, content: string): CodeChunk[] {
    const result = this.astParser.parse(filePath, content)
    const lines = content.split('\n')
    const totalLines = lines.length

    // 有符号：按符号边界分块
    if (result.symbols.length > 0) {
      // 过滤掉没有行信息的符号，并按行号排序
      const sorted = result.symbols
        .filter((s) => s.line != null && s.line > 0)
        .sort((a, b) => a.line - b.line)

      if (sorted.length > 0) {
        const chunks: CodeChunk[] = []
        for (let i = 0; i < sorted.length; i++) {
          const sym = sorted[i]
          const startLine = sym.line
          // endLine: 优先用符号自带的 endLine，否则取下一个符号的 startLine - 1，否则取文件末尾
          const endLine = sym.endLine
            ?? (i + 1 < sorted.length ? sorted[i + 1].line - 1 : totalLines)
          const clampedEnd = Math.min(endLine, totalLines)
          const contentSlice = lines.slice(startLine - 1, clampedEnd).join('\n')
          chunks.push({
            filePath,
            startLine,
            endLine: clampedEnd,
            kind: sym.kind,
            name: sym.name,
            content: contentSlice,
          })
        }
        return chunks
      }

      // 所有符号都没有行信息，回退到固定行数分块
      return this.fallbackLineChunks(filePath, content, 50)
    }

    // 无符号：整个文件作为一个 module chunk
    if (totalLines === 0) {
      return [{ filePath, startLine: 1, endLine: 1, kind: 'module', name: path.basename(filePath), content: '' }]
    }
    return [{ filePath, startLine: 1, endLine: totalLines, kind: 'module', name: path.basename(filePath), content }]
  }

  /**
   * 固定行数回退分块
   */
  private fallbackLineChunks(filePath: string, content: string, chunkSize: number): CodeChunk[] {
    const lines = content.split('\n')
    const totalLines = lines.length
    if (totalLines === 0) {
      return [{ filePath, startLine: 1, endLine: 1, kind: 'module', name: path.basename(filePath), content: '' }]
    }
    const chunks: CodeChunk[] = []
    for (let start = 1; start <= totalLines; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, totalLines)
      const contentSlice = lines.slice(start - 1, end).join('\n')
      chunks.push({
        filePath,
        startLine: start,
        endLine: end,
        kind: 'module',
        name: `${path.basename(filePath)}:${start}-${end}`,
        content: contentSlice,
      })
    }
    return chunks
  }

  /**
   * 清除单个文件的符号索引（供 FileWatcher 调用）
   */
  async clearFileIndex(filePath: string): Promise<void> {
    await this.symbolIndex.clearFile(filePath)
  }

  /**
   * 索引项目并生成语义分块和可选嵌入向量
   * 不写入 memory_items，仅返回分块及嵌入结果，由调用方负责持久化
   */
  async indexWithEmbeddings(
    options: IndexOptions,
    embeddingFn?: (text: string) => Promise<number[]>
  ): Promise<{
    filesIndexed: number
    chunksCreated: number
    embeddingsGenerated: number
    chunks: Array<CodeChunk & { embedding?: number[] }>
  }> {
    const include = options.includePatterns ?? ['**/*.{ts,tsx,js,jsx}']
    const exclude = options.excludePatterns ?? ['node_modules/**', 'dist/**', '.git/**', 'build/**', '.next/**']

    const files = await this.collectFiles(options.projectPath, include, exclude)

    let chunksCreated = 0
    let embeddingsGenerated = 0
    const allChunks: Array<CodeChunk & { embedding?: number[] }> = []

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, 'utf-8')

        // 解析符号并插入索引（与 indexProject 一致）
        const result = this.astParser.parse(filePath, content)
        await this.symbolIndex.insertSymbols(result.symbols)
        await this.symbolIndex.insertImportEdges(result.imports)

        // 语义分块
        const chunks = this.chunkFile(filePath, content)

        for (const chunk of chunks) {
          const enriched: CodeChunk & { embedding?: number[] } = { ...chunk }

          if (embeddingFn) {
            try {
              enriched.embedding = await embeddingFn(chunk.content)
              embeddingsGenerated++
            } catch (err) {
              console.warn(`Embedding generation failed for ${chunk.filePath}:${chunk.startLine}`, err)
            }
          }

          allChunks.push(enriched)
          chunksCreated++
        }
      } catch (err) {
        console.warn(`Failed to index ${filePath}:`, err)
      }
    }

    return { filesIndexed: files.length, chunksCreated, embeddingsGenerated, chunks: allChunks }
  }

  private async collectFiles(projectPath: string, include: string[], exclude: string[]): Promise<string[]> {
    const results: string[] = []

    // 将 glob 排除模式分为两类：
    // - excludeNames: 纯目录名（单段，如 node_modules），用于每级快速匹配
    // - excludePrefixes: 含路径的模式（多段，如 packages/foo/dist），归一为绝对路径前缀
    const normalizedExcludes = exclude.map((e) =>
      e.replace(/[/\\]\*\*$/, '').replace(/[/\\]+$/, ''),
    )
    const excludeNames = new Set<string>()
    const excludePrefixes: string[] = []
    for (const e of normalizedExcludes) {
      if (!e) continue
      const segments = e.split(/[/\\]/).filter(Boolean)
      if (segments.length <= 1) {
        excludeNames.add(e)
      } else {
        // 归一为绝对路径前缀，用于 walkDir 按 fullPath 前缀匹配
        excludePrefixes.push(path.resolve(projectPath, e))
      }
    }

    const visited = new Set<string>()
    await this.walkDir(projectPath, results, excludeNames, excludePrefixes, visited, 0)

    // 按 include 模式过滤
    return results.filter((f) => include.some((p) => this.matchGlob(f, p)))
  }

  /** 目录递归最大深度，防止符号链接环或异常深层级导致栈溢出/挂起 */
  private static readonly MAX_WALK_DEPTH = 25

  private async walkDir(
    dir: string,
    results: string[],
    excludeNames: Set<string>,
    excludePrefixes: string[],
    visited: Set<string>,
    depth: number,
  ): Promise<void> {
    if (depth > ProjectIndexer.MAX_WALK_DEPTH) return

    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // 按目录名匹配单段排除项，按绝对路径前缀匹配多段排除项；跳过隐藏目录
        // 注：不再无条件跳过符号链接目录，visited 集合（基于 realpath）已防止循环
        if (
          excludeNames.has(entry.name) ||
          entry.name.startsWith('.') ||
          excludePrefixes.some((p) => fullPath === p || fullPath.startsWith(p + path.sep))
        ) {
          continue
        }
        // 仅对将要递归的目录做 realpath 去重，避免被排除的目录（如 node_modules）
        // 污染 visited 集合，导致后续经符号链接指向其内部源码的合法路径被误判为已访问。
        let realDir: string
        try {
          realDir = await fsSync.promises.realpath(fullPath)
        } catch {
          realDir = path.resolve(fullPath)
        }
        if (visited.has(realDir)) continue
        visited.add(realDir)
        await this.walkDir(fullPath, results, excludeNames, excludePrefixes, visited, depth + 1)
      } else if (entry.isFile()) {
        results.push(fullPath)
      }
    }
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    // 简化版 glob 匹配：只支持 **/*.{ext1,ext2} 模式
    const match = pattern.match(/^\*\*\/\*\.(\w+(?:,\w+)*)$/)
    if (match) {
      const exts = match[1].split(',')
      return exts.some((ext) => filePath.endsWith(`.${ext.trim()}`))
    }
    // 回退：简单后缀匹配
    return pattern.includes('.')
      ? filePath.endsWith(pattern.replace('**/*', ''))
      : true
  }
}
