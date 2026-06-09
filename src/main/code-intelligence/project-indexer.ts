/**
 * 项目级代码索引器
 * 扫描项目中的所有源码文件，解析 AST，构建符号索引和依赖图
 */

import * as fsSync from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import * as ts from 'typescript'
import { AstParser } from './ast-parser'
import { SymbolIndex } from './symbol-index'

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

    // 解析每个文件
    for (const filePath of files) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const result = this.astParser.parse(filePath, content)

        await this.symbolIndex.insertSymbols(result.symbols)
        await this.symbolIndex.insertImportEdges(result.imports)

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
    await this.symbolIndex.clearFile(filePath)
    const content = await readFile(filePath, 'utf-8')
    const result = this.astParser.parse(filePath, content)
    await this.symbolIndex.insertSymbols(result.symbols)
    await this.symbolIndex.insertImportEdges(result.imports)
    return { symbolsFound: result.symbols.length, importsFound: result.imports.length }
  }

  /**
   * 清除单个文件的符号索引（供 FileWatcher 调用）
   */
  async clearFileIndex(filePath: string): Promise<void> {
    await this.symbolIndex.clearFile(filePath)
  }

  private async collectFiles(projectPath: string, include: string[], exclude: string[]): Promise<string[]> {
    const results: string[] = []

    // 简单递归实现
    await this.walkDir(projectPath, results, exclude.map((e) => e.replace('/**', '')))

    // 按 include 模式过滤
    return results.filter((f) => include.some((p) => this.matchGlob(f, p)))
  }

  private async walkDir(dir: string, results: string[], excludeDirs: string[]): Promise<void> {
    let entries: import('node:fs').Dirent[]
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
