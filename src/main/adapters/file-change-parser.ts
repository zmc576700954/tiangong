/**
 * 文件变更解析工具
 * 从 BaseAdapter 中提取，降低单文件复杂度
 *
 * 解析 Agent 输出中的文件变更信息，支持多重过滤降低误报：
 * - 排除 Markdown 代码块内部
 * - 排除示例/讨论语气
 * - 排除列表项和引用块
 * - 要求路径包含目录分隔符
 */

import type { AgentOutput } from '@shared/types'

/** 文件扩展名快速预检查 */
const FILE_EXT_QUICK_CHECK = /\.(ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml)\b/

/** 最大解析长度 */
const MAX_PARSE_LENGTH = 50_000

/** 示例/讨论语气标记 */
const EXAMPLE_MARKERS = /\b(e\.g\.|for example|such as|like this|similar to)\b/gi

/** 文件变更模式 */
const FILE_PATTERN = /(?:edit|modify|update|create|add|delete|remove)\s+(?:file\s+)?[`'"]?([\w/\\.-]+\.(?:ts|tsx|js|jsx|py|java|go|rs|md|json|yaml|yml))[`'"]?/gi

/**
 * 解析文本中的文件变更信息
 * @param text - Agent 输出文本
 * @param emitOutput - 输出回调函数
 */
export function parseFileChanges(
  text: string,
  emitOutput: (output: AgentOutput) => void,
): void {
  if (text.length > MAX_PARSE_LENGTH) return
  if (!FILE_EXT_QUICK_CHECK.test(text)) return

  const lines = text.split('\n')
  let inCodeBlock = false

  for (const line of lines) {
    FILE_PATTERN.lastIndex = 0
    const trimmed = line.trim()

    // 跳过 Markdown 代码块边界和内部行
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    // 跳过列表项、引用块、表格行
    if (/^[-*+>]\s/.test(trimmed)) continue
    if (/^\|/.test(trimmed)) continue

    // 跳过示例/讨论语气
    if (EXAMPLE_MARKERS.test(trimmed)) continue

    // 逐行匹配，避免跨行误匹配
    let match: RegExpExecArray | null
    while ((match = FILE_PATTERN.exec(trimmed)) !== null) {
      const filePath = match[1]
      // 要求路径包含目录分隔符，排除孤立文件名
      if (!filePath.includes('/') && !filePath.includes('\\')) continue

      const changeType = inferChangeType(match[0])
      emitOutput({
        type: 'file_change',
        data: `${changeType}: ${filePath}`,
        timestamp: Date.now(),
        filePath,
        changeType,
      })
    }
  }
}

/**
 * 根据动作文本推断变更类型
 */
export function inferChangeType(actionText: string): 'add' | 'modify' | 'delete' {
  const lower = actionText.toLowerCase()
  if (lower.includes('create') || lower.includes('add')) return 'add'
  if (lower.includes('delete') || lower.includes('remove')) return 'delete'
  return 'modify'
}
