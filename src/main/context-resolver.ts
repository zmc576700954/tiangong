/**
 * Context Resolver
 *
 * 将轻量 ContextRef 解析为包含实际内容的 ResolvedContext。
 * 用于注入到 Agent prompt 中，提供业务上下文。
 *
 * 设计原则：
 * - 节点上下文优先级高于文件（业务语义 > 代码片段）
 * - Token 预算机制防止 context window 溢出
 * - 文件内容截取前 N 行，而非全量读取
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ContextRef, ResolvedContext, GraphNode } from '@shared/types'

import { estimateTokens } from './shared/token-utils'

/** 文件内容最大读取行数 */
const MAX_FILE_LINES = 100

/** 文件内容最大字符数 */
const MAX_FILE_CHARS = 16000

/** TTL 缓存有效期（毫秒） */
const FILE_CACHE_TTL = 10000

/** 缓存最大条目数，超出时淘汰最早条目（FIFO） */
const FILE_CACHE_MAX_SIZE = 200

/**
 * 截断文本到指定 token 预算（CJK 感知）
 */
export function truncateToBudget(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text)
  if (estimated <= maxTokens) return text
  const ratio = maxTokens / estimated
  const charBudget = Math.floor(text.length * ratio * 0.9) // 留 10% 余量
  return text.slice(0, charBudget) + '\n\n[truncated]'
}

export interface ResolveOptions {
  /** 用于解析 node refs 的节点列表（从 DB 或 store 获取） */
  nodes?: GraphNode[]
  /** 文件路径解析的基准目录 */
  basePath?: string
}

export class ContextResolver {
  private fileCache = new Map<string, { content: string; timestamp: number }>()

  /**
   * 向缓存添加条目，超过大小时淘汰最早条目
   */
  private addToCache(key: string, value: { content: string; timestamp: number }): void {
    // 删除旧条目以保证新条目在末尾（FIFO 顺序）
    if (this.fileCache.has(key)) {
      this.fileCache.delete(key)
    }
    // 超过大小时删除最早条目
    if (this.fileCache.size >= FILE_CACHE_MAX_SIZE) {
      const oldestKey = this.fileCache.keys().next().value
      if (oldestKey !== undefined) {
        this.fileCache.delete(oldestKey)
      }
    }
    this.fileCache.set(key, value)
  }

  /**
   * 解析 ContextRef[] 为 ResolvedContext[]
   * @param refs - 上下文引用列表
   * @param budget - token 预算上限
   * @param options - 解析选项
   */
  async resolve(
    refs: ContextRef[],
    budget: number,
    options: ResolveOptions = {},
  ): Promise<ResolvedContext[]> {
    if (refs.length === 0) return []

    // 按优先级排序：node > file
    const sorted = [...refs].sort((a, b) => {
      const priority = { node: 0, file: 1, text: 2 }
      return (priority[a.type] ?? 2) - (priority[b.type] ?? 2)
    })

    // 阶段1: 并行解析所有 ref 的原始内容（node/text 同步，file 异步读取）
    const rawContents = await Promise.all(
      sorted.map(async (ref) => {
        if (ref.type === 'node') {
          return this.resolveNode(ref, options.nodes ?? [])
        } else if (ref.type === 'file') {
          return this.resolveFile(ref, options.basePath)
        } else if (ref.type === 'text') {
          return this.resolveText(ref)
        }
        return ''
      }),
    )

    // 阶段2: 串行应用 token 预算截断（保证优先级顺序）
    const results: ResolvedContext[] = []
    let remaining = budget

    for (let i = 0; i < sorted.length; i++) {
      if (remaining <= 0) break

      const content = truncateToBudget(rawContents[i], remaining)
      const tokenEstimate = estimateTokens(content)

      results.push({
        type: sorted[i].type,
        id: sorted[i].id,
        label: sorted[i].label,
        content,
        tokenEstimate,
      })

      remaining -= tokenEstimate
    }

    return results
  }

  private resolveNode(ref: ContextRef, nodes: GraphNode[]): string {
    const node = nodes.find((n) => n.id === ref.id)
    if (!node) return `[节点未找到: ${ref.label}]`

    const lines: string[] = []

    lines.push(`节点: ${node.title} (${node.type})`)
    if (node.description) lines.push(`描述: ${node.description}`)

    if (node.rules && node.rules.length > 0) {
      lines.push('业务规则:')
      for (const rule of node.rules) {
        lines.push(`  - ${rule.title}`)
        if (rule.condition) lines.push(`    条件: ${rule.condition}`)
        if (rule.action) lines.push(`    动作: ${rule.action}`)
      }
    }

    if (node.acceptanceCriteria && node.acceptanceCriteria.length > 0) {
      lines.push('验收标准:')
      for (const criteria of node.acceptanceCriteria) {
        lines.push(`  - ${criteria}`)
      }
    }

    if (node.metadata) {
      if (node.metadata.apis && node.metadata.apis.length > 0) {
        lines.push('APIs: ' + node.metadata.apis.map((a) => a.name).join(', '))
      }
      if (node.metadata.services && node.metadata.services.length > 0) {
        lines.push('Services: ' + node.metadata.services.map((s) => s.name).join(', '))
      }
      if (node.metadata.entities && node.metadata.entities.length > 0) {
        lines.push('Entities: ' + node.metadata.entities.map((e) => e.name).join(', '))
      }
    }

    return lines.join('\n')
  }

  private async resolveFile(ref: ContextRef, basePath?: string): Promise<string> {
    // 必须提供 basePath 才能读取文件，防止无限制的文件系统访问
    if (!basePath) {
      return `[无法读取文件: 未提供基础路径 (${ref.label})]`
    }

    // 拒绝绝对路径的引用（必须通过相对路径指定）
    if (path.isAbsolute(ref.id)) {
      return `[路径越界: ${ref.label} (${ref.id})]`
    }

    const resolvedPath = path.resolve(basePath, ref.id)
    const resolvedBase = path.resolve(basePath)
    const relative = path.relative(resolvedBase, resolvedPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return `[路径越界: ${ref.label} (${ref.id})]`
    }

    try {
      // Check TTL cache first
      const cached = this.fileCache.get(resolvedPath)
      if (cached && Date.now() - cached.timestamp < FILE_CACHE_TTL) {
        return cached.content
      }

      const content = await readFile(resolvedPath, 'utf-8')
      const lines = content.split('\n')

      let result: string
      if (lines.length > MAX_FILE_LINES) {
        const truncated = lines.slice(0, MAX_FILE_LINES).join('\n')
        result = `${truncated}\n\n[文件共 ${lines.length} 行，仅显示前 ${MAX_FILE_LINES} 行]`
      } else if (content.length > MAX_FILE_CHARS) {
        result = content.slice(0, MAX_FILE_CHARS) + `\n\n[文件内容过长，已截断]`
      } else {
        result = content
      }

      this.addToCache(resolvedPath, { content: result, timestamp: Date.now() })
      return result
    } catch {
      return `[无法读取文件: ${ref.label} (${ref.id})]`
    }
  }

  private resolveText(ref: ContextRef): string {
    return ref.content ?? `[无文本内容: ${ref.label}]`
  }
}
