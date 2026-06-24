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

    // 收集所有匹配的文件
    const files = await this.collectFiles(options.projectPath, include, exclude)

    let symbolsFound = 0
    let importsFound = 0
    const allSymbols: SymbolInfo[] = []
    const allEdges: ImportEdge[] = []

    // 解析每个文件：先累计符号/边，最后批量插入，避免每个文件都触发 DB 往返
    for (const filePath of files) {
      try {
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
   */
  async reindexFile(filePath: string): Promise<{ symbolsFound: number; importsFound: number }> {
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

    // 简单递归实现
    await this.walkDir(projectPath, results, exclude.map((e) => e.replace('/**', '')))

    // 按 include 模式过滤
    return results.filter((f) => include.some((p) => this.matchGlob(f, p)))
  }

  private async walkDir(dir: string, results: string[], excludeDirs: string[]): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!excludeDirs.some((e) => fullPath.includes(e)) && !entry.name.startsWith('.')) {
          await this.walkDir(fullPath, results, excludeDirs)
        }
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
