/**
 * 智能上下文解析器
 * 从用户查询出发，通过符号索引和依赖图找到最相关的代码上下文
 *
 * 优化策略：
 * - TTL 缓存：5秒内相同请求直接返回缓存结果
 * - 并行化：同类型实体并行查询、依赖图批量并行扩展、导入关系并行获取
 */

import * as path from 'node:path'
import { readFile as readFs } from 'node:fs/promises'
import type { SymbolQueryResult, GraphNode } from '@shared/types'
import { type SymbolIndex } from './symbol-index'
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

/** 缓存条目 */
interface CacheEntry {
  timestamp: number
  result: ResolvedCodeContext
}

/**
 * 智能上下文解析器
 * 从用户查询出发，通过符号索引和依赖图找到最相关的代码上下文
 */
export class SmartContextResolver {
  private symbolIndex: SymbolIndex
  private entityExtractor: EntityExtractor

  /** 带 TTL 的上下文缓存（Map 保持插入顺序，用于 LRU 淘汰） */
  private contextCache = new Map<string, CacheEntry>()
  private readonly CACHE_TTL = 5000 // 5秒缓存
  private readonly MAX_CACHE_SIZE = 50 // 最大缓存条目数

  constructor(symbolIndex: SymbolIndex) {
    this.symbolIndex = symbolIndex
    this.entityExtractor = new EntityExtractor()
  }

  /**
   * 解析用户查询，返回智能组装的代码上下文
   */
  async resolve(options: SmartContextOptions): Promise<ResolvedCodeContext> {
    // 缓存检查
    const cacheKey = this.buildCacheKey(options)
    const cached = this.contextCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.result
    }

    const extraction = this.entityExtractor.extract(options.userQuery)
    const maxSymbols = options.maxSymbols ?? 20
    const maxFiles = options.maxFiles ?? 10
    const depth = options.dependencyDepth ?? 2

    // 阶段 1: 基于提取的实体查找符号（内部并行化）
    const primarySymbols = await this.findSymbolsFromEntities(extraction, maxSymbols)

    // 阶段 2: 沿依赖图扩展（内部并行化）
    const { relatedSymbols, relatedFiles } = await this.expandByDependencyGraph(
      primarySymbols,
      maxSymbols - primarySymbols.length,
      maxFiles,
      depth,
      options.projectPath
    )

    // 阶段 3 + 阶段 4 互相独立，并行执行
    const [importGraph, summary] = await Promise.all([
      this.buildImportGraphSnippet(primarySymbols, relatedSymbols),
      Promise.resolve(this.buildContextSummary(extraction, primarySymbols, relatedSymbols)),
    ])

    const result: ResolvedCodeContext = { primarySymbols, relatedSymbols, relatedFiles, importGraph, summary }

    // 写入缓存
    this.setCache(cacheKey, result)

    return result
  }

  // ─── 缓存相关方法 ───────────────────────────────────────

  private buildCacheKey(options: SmartContextOptions): string {
    return JSON.stringify({ query: options.userQuery, scope: options.projectPath, nodes: options.nodes?.map((n) => n.id) })
  }

  private setCache(key: string, result: ResolvedCodeContext): void {
    // 先清理过期条目
    if (this.contextCache.size >= this.MAX_CACHE_SIZE) {
      this.evictExpiredEntries()
      // 如果清理后仍然满，按 LRU（插入序）淘汰最旧条目
      if (this.contextCache.size >= this.MAX_CACHE_SIZE) {
        const oldestKey = this.contextCache.keys().next().value
        if (oldestKey !== undefined) {
          this.contextCache.delete(oldestKey)
        }
      }
    }
    this.contextCache.set(key, { timestamp: Date.now(), result })
  }

  /** 清理所有过期缓存条目 */
  private evictExpiredEntries(): void {
    const now = Date.now()
    for (const [key, entry] of this.contextCache) {
      if (now - entry.timestamp >= this.CACHE_TTL) {
        this.contextCache.delete(key)
      }
    }
  }

  // ─── 阶段 1: 符号查找（同类型实体并行查询） ─────────────

  private async findSymbolsFromEntities(extraction: ExtractionResult, limit: number): Promise<SymbolQueryResult[]> {
    const results: SymbolQueryResult[] = []
    const seen = new Set<string>()

    // 按实体类型优先级查询：class > method > interface > file > keyword
    const priorityOrder: Array<ExtractionResult['entities'][number]['type']> = [
      'class', 'method', 'function', 'interface', 'file', 'module', 'keyword'
    ]

    for (const type of priorityOrder) {
      if (results.length >= limit) break

      const entitiesOfType = extraction.entities.filter((e) => e.type === type)
      if (entitiesOfType.length === 0) continue

      // 同一类型内的实体并行查询，减少串行等待
      const queryResults = await Promise.all(
        entitiesOfType.map((entity) => {
          if (type === 'file') {
            // 文件路径类型的实体：获取该文件的所有导出符号
            return this.symbolIndex.getSymbolsByFile(entity.name)
              .then((symbols) => symbols
                .filter((s) => s.isExported)
                .map((s) => ({ symbol: s, score: entity.confidence, matchedBy: 'path' as const }))
              )
          } else {
            // 其他类型：按名称查询符号
            const kind =
              type === 'method' ? 'method'
              : type === 'function' ? 'function'
              : type === 'interface' ? 'interface'
              : type === 'class' ? 'class'
              : undefined
            return this.symbolIndex.querySymbols(entity.name, { kind, limit: 5 })
              .then((found) => found.map((f) => ({ ...f, score: f.score * entity.confidence })))
          }
        })
      )

      // 合并结果，去重
      for (const entityResults of queryResults) {
        for (const r of entityResults) {
          if (results.length >= limit) break
          if (!seen.has(r.symbol.id)) {
            seen.add(r.symbol.id)
            results.push(r)
          }
        }
        if (results.length >= limit) break
      }
    }

    return results.sort((a, b) => b.score - a.score)
  }

  // ─── 阶段 2: 依赖图扩展（批量并行） ────────────────────

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

    // 收集主符号的唯一文件路径
    const uniqueFiles = [...new Set(primarySymbols.map((s) => s.symbol.filePath))]
    // 先将所有主文件标记为已处理，避免重复
    for (const f of uniqueFiles) {
      processedFiles.add(f)
    }

    // 批量并行获取所有主文件的相关文件
    const relatedFilesMaps = await Promise.all(
      uniqueFiles.map(async (filePath) => ({
        filePath,
        related: await this.symbolIndex.getRelatedFiles(filePath, depth),
      }))
    )

    // 合并去重相关文件，按距离排序（近优先）
    const allRelatedEntries: Array<{ filePath: string; distance: number; primaryFilePath: string }> = []
    for (const { filePath: primaryFilePath, related } of relatedFilesMaps) {
      for (const [filePath, distance] of related.entries()) {
        if (!processedFiles.has(filePath)) {
          allRelatedEntries.push({ filePath, distance, primaryFilePath })
        }
      }
    }
    allRelatedEntries.sort((a, b) => a.distance - b.distance)

    // 取前 fileLimit 个相关文件
    const selectedEntries = allRelatedEntries.slice(0, fileLimit)
    for (const entry of selectedEntries) {
      processedFiles.add(entry.filePath)
    }

    // 并行读取文件内容 + 提取符号
    const fileResults = await Promise.all(
      selectedEntries.map(async (entry) => {
        const [content, fileSymbols] = await Promise.all([
          this.readFileWithSmartTruncation(entry.filePath, projectPath),
          this.symbolIndex.getSymbolsByFile(entry.filePath),
        ])
        return { ...entry, content, fileSymbols }
      })
    )

    // 顺序处理结果以保持语义一致
    for (const entry of fileResults) {
      const exportedSymbols = entry.fileSymbols
        .filter((s) => s.isExported && !seenSymbolIds.has(s.id))
        .slice(0, 3) // 每个相关文件最多取 3 个导出符号

      for (const s of exportedSymbols) {
        if (relatedSymbols.length >= symbolLimit) break
        seenSymbolIds.add(s.id)
        relatedSymbols.push({
          symbol: s,
          score: Math.max(0.3, 1 - entry.distance * 0.3), // 距离越远得分越低
          matchedBy: entry.distance === 1 ? 'exact' : 'fuzzy',
        })
      }

      relatedFiles.push({
        filePath: entry.filePath,
        distance: entry.distance,
        reason: `被 ${path.basename(entry.primaryFilePath)} ${entry.distance === 1 ? '直接' : '间接'}引用`,
        content: entry.content,
      })
    }

    return { relatedSymbols, relatedFiles }
  }

  // ─── 文件读取（智能截断） ──────────────────────────────

  private async readFileWithSmartTruncation(filePath: string, projectPath: string): Promise<string> {
    try {
      // 使用 path.isAbsolute 代替 startsWith('/')，兼容 Windows 绝对路径（如 C:\...）
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath)
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

  // ─── 阶段 3: 依赖图摘要（并行获取导入关系） ────────────

  private async buildImportGraphSnippet(
    primarySymbols: SymbolQueryResult[],
    relatedSymbols: SymbolQueryResult[]
  ): Promise<Array<{ from: string; to: string }>> {
    const edges = new Set<string>()
    const allFiles = [...new Set([...primarySymbols, ...relatedSymbols].map((s) => s.symbol.filePath))]

    // 并行获取所有文件的导入关系
    const importResults = await Promise.all(
      allFiles.map(async (file) => ({
        file,
        imports: await this.symbolIndex.getImports(file),
      }))
    )

    for (const { imports } of importResults) {
      for (const imp of imports) {
        if (allFiles.includes(imp.toFile)) {
          edges.add(`${imp.fromFile} -> ${imp.toFile}`)
        }
      }
    }

    return Array.from(edges).map((e) => {
      const [from, to] = e.split(' -> ')
      return { from: path.basename(from), to: path.basename(to) }
    })
  }

  // ─── 阶段 4: 上下文摘要 ───────────────────────────────

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
