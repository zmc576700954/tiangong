/**
 * 智能上下文解析器
 * 从用户查询出发，通过符号索引和依赖图找到最相关的代码上下文
 */

import * as path from 'node:path'
import { readFile as readFs } from 'node:fs/promises'
import type { SymbolInfo, SymbolQueryResult, GraphNode } from '@shared/types'
import { SymbolIndex } from './symbol-index'
import { EntityExtractor, type ExtractionResult } from './entity-extractor'

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
  async resolve(options: SmartContextOptions): Promise<ResolvedCodeContext> {
    const extraction = this.entityExtractor.extract(options.userQuery)
    const maxSymbols = options.maxSymbols ?? 20
    const maxFiles = options.maxFiles ?? 10
    const depth = options.dependencyDepth ?? 2

    // 阶段 1: 基于提取的实体查找符号
    const primarySymbols = await this.findSymbolsFromEntities(extraction, maxSymbols)

    // 阶段 2: 沿依赖图扩展
    const { relatedSymbols, relatedFiles } = await this.expandByDependencyGraph(
      primarySymbols,
      maxSymbols - primarySymbols.length,
      maxFiles,
      depth,
      options.projectPath
    )

    // 阶段 3: 构建依赖图摘要
    const importGraph = await this.buildImportGraphSnippet(primarySymbols, relatedSymbols)

    // 阶段 4: 生成上下文摘要
    const summary = this.buildContextSummary(extraction, primarySymbols, relatedSymbols)

    return { primarySymbols, relatedSymbols, relatedFiles, importGraph, summary }
  }

  private async findSymbolsFromEntities(extraction: ExtractionResult, limit: number): Promise<SymbolQueryResult[]> {
    const results: SymbolQueryResult[] = []
    const seen = new Set<string>()

    // 按实体类型优先级查询：class > method > interface > file > keyword
    const priorityOrder: Array<ExtractionResult['entities'][number]['type']> = [
      'class', 'method', 'function', 'interface', 'file', 'module', 'keyword'
    ]

    for (const type of priorityOrder) {
      const entitiesOfType = extraction.entities.filter((e) => e.type === type)
      for (const entity of entitiesOfType) {
        if (results.length >= limit) break

        if (type === 'file') {
          // 文件路径类型的实体：获取该文件的所有导出符号
          const fileSymbols = (await this.symbolIndex.getSymbolsByFile(entity.name))
            .filter((s) => s.isExported)
            .map((s) => ({ symbol: s, score: entity.confidence, matchedBy: 'path' as const }))
          for (const fs of fileSymbols) {
            if (!seen.has(fs.symbol.id)) {
              seen.add(fs.symbol.id)
              results.push(fs)
            }
          }
        } else {
          // 其他类型：按名称查询符号
          const kind =
            type === 'method' ? 'method'
            : type === 'function' ? 'function'
            : type === 'interface' ? 'interface'
            : type === 'class' ? 'class'
            : undefined
          const found = await this.symbolIndex.querySymbols(entity.name, { kind, limit: 5 })
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

  private async expandByDependencyGraph(
    primarySymbols: SymbolQueryResult[],
    symbolLimit: number,
    fileLimit: number,
    depth: number,
    projectPath: string
  ): Promise<{ relatedSymbols: SymbolQueryResult[]; relatedFiles: ResolvedCodeContext['relatedFiles'] }> {
    const relatedSymbols: SymbolQueryResult[] = []
    const relatedFiles: ResolvedCodeContext['relatedFiles'] = []
    const processedFiles = new Set<string>()
    const seenSymbolIds = new Set(primarySymbols.map((s) => s.symbol.id))

    for (const primary of primarySymbols) {
      if (processedFiles.has(primary.symbol.filePath)) continue
      processedFiles.add(primary.symbol.filePath)

      // 获取依赖图中的相关文件
      const relatedFilePaths = await this.symbolIndex.getRelatedFiles(primary.symbol.filePath, depth)

      for (const [filePath, distance] of relatedFilePaths.entries()) {
        if (processedFiles.size >= fileLimit) break
        if (processedFiles.has(filePath)) continue
        processedFiles.add(filePath)

        // 读取文件内容（智能截断，优先读取导出符号）
        const content = await this.readFileWithSmartTruncation(filePath, projectPath)

        // 从相关文件中提取高价值符号（导出的类/接口/函数）
        const fileSymbols = (await this.symbolIndex.getSymbolsByFile(filePath))
          .filter((s) => s.isExported && !seenSymbolIds.has(s.id))
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

  private async readFileWithSmartTruncation(filePath: string, projectPath: string): Promise<string> {
    try {
      const fullPath = filePath.startsWith('/') ? filePath : path.join(projectPath, filePath)
      const content = await readFs(fullPath, 'utf-8')

      // 策略：如果文件不大，返回全部；如果很大，优先返回导出符号的定义部分
      if (content.length < 8000) return content

      const symbols = await this.symbolIndex.getSymbolsByFile(fullPath)
      const exportedSymbols = symbols.filter((s) => s.isExported)
      if (exportedSymbols.length === 0) {
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

  private async buildImportGraphSnippet(
    primarySymbols: SymbolQueryResult[],
    relatedSymbols: SymbolQueryResult[]
  ): Promise<Array<{ from: string; to: string }>> {
    const edges = new Set<string>()
    const allFiles = new Set([...primarySymbols, ...relatedSymbols].map((s) => s.symbol.filePath))

    for (const file of allFiles) {
      const imports = await this.symbolIndex.getImports(file)
      for (const imp of imports) {
        if (allFiles.has(imp.toFile)) {
          edges.add(`${imp.fromFile} -> ${imp.toFile}`)
        }
      }
    }

    return Array.from(edges).map((e) => {
      const [from, to] = e.split(' -> ')
      return { from: path.basename(from), to: path.basename(to) }
    })
  }

  private buildContextSummary(
    extraction: ExtractionResult,
    primary: SymbolQueryResult[],
    related: SymbolQueryResult[]
  ): string {
    const parts: string[] = []
    parts.push(`意图: ${extraction.intent}`)
    if (extraction.targetDescription) {
      parts.push(`目标: ${extraction.targetDescription}`)
    }
    if (primary.length > 0) {
      parts.push(`核心符号: ${primary.map((s) => s.symbol.name).join(', ')}`)
    }
    if (related.length > 0) {
      parts.push(`相关符号: ${related.slice(0, 5).map((s) => s.symbol.name).join(', ')}`)
    }
    return parts.join('\n')
  }
}
