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

/** 每个 token 约 4 个字符（中英混合估算） */
const CHARS_PER_TOKEN = 4

/** 文件内容最大读取行数 */
const MAX_FILE_LINES = 100

/** 文件内容最大字符数 */
const MAX_FILE_CHARS = 16000

/**
 * 粗估文本的 token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 截断文本到指定 token 预算
 */
export function truncateToBudget(text: string, maxTokens: number): string {
  // 预留 1 个 token 给截断后缀，避免溢出预算
  const maxChars = (maxTokens - 1) * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars)) + '\n\n[truncated]'
}

export interface ResolveOptions {
  /** 用于解析 node refs 的节点列表（从 DB 或 store 获取） */
  nodes?: GraphNode[]
  /** 文件路径解析的基准目录 */
  basePath?: string
}

export class ContextResolver {
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

    const results: ResolvedContext[] = []
    let remaining = budget

    for (const ref of sorted) {
      if (remaining <= 0) break

      let rawContent = ''
      if (ref.type === 'node') {
        rawContent = this.resolveNode(ref, options.nodes ?? [])
      } else if (ref.type === 'file') {
        rawContent = await this.resolveFile(ref, options.basePath)
      } else if (ref.type === 'text') {
        rawContent = this.resolveText(ref)
      }

      const content = truncateToBudget(rawContent, remaining)
      const tokenEstimate = estimateTokens(content)

      results.push({
        type: ref.type,
        id: ref.id,
        label: ref.label,
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
      const content = await readFile(resolvedPath, 'utf-8')
      const lines = content.split('\n')

      if (lines.length > MAX_FILE_LINES) {
        const truncated = lines.slice(0, MAX_FILE_LINES).join('\n')
        return `${truncated}\n\n[文件共 ${lines.length} 行，仅显示前 ${MAX_FILE_LINES} 行]`
      }

      if (content.length > MAX_FILE_CHARS) {
        return content.slice(0, MAX_FILE_CHARS) + `\n\n[文件内容过长，已截断]`
      }

      return content
    } catch {
      return `[无法读取文件: ${ref.label} (${ref.id})]`
    }
  }

  private resolveText(ref: ContextRef): string {
    return ref.content ?? `[无文本内容: ${ref.label}]`
  }
}
