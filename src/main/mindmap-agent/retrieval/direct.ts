/**
 * Direct Retrieval — 单节点直查
 *
 * 最简单的检索：直接读取目标节点的关联文件内容。
 * 适用于 enrichNode 场景。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { NodeType } from '@shared/types'

export interface DirectRetrievalResult {
  nodeContent: string
  relatedFileContents: Array<{ path: string; content: string }>
  tokenEstimate: number
}

/** Token 粗估 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5 + other / 4)
}

/**
 * 直接检索节点关联内容
 */
export async function directRetrieve(
  projectPath: string,
  nodeTitle: string,
  nodeType: NodeType,
  relatedFiles: string[] = [],
): Promise<DirectRetrievalResult> {
  const TOKEN_BUDGET = 6000
  let usedTokens = 0
  const fileContents: Array<{ path: string; content: string }> = []

  // 读取关联文件
  for (const relFile of relatedFiles.slice(0, 10)) {
    if (usedTokens >= TOKEN_BUDGET) break

    const fullPath = path.resolve(projectPath, relFile)
    try {
      const content = await fs.readFile(fullPath, 'utf-8')
      const truncated = content.substring(0, 3000) // 每个文件最多 3000 字符
      const tokens = estimateTokens(truncated)

      if (usedTokens + tokens <= TOKEN_BUDGET) {
        fileContents.push({ path: relFile, content: truncated })
        usedTokens += tokens
      }
    } catch {
      // 文件不存在或无法读取，跳过
    }
  }

  // 如果没有 relatedFiles，尝试根据节点名搜索文件
  if (fileContents.length === 0) {
    const found = await searchByNodeTitle(projectPath, nodeTitle, nodeType)
    for (const { filePath, content } of found) {
      if (usedTokens >= TOKEN_BUDGET) break
      const tokens = estimateTokens(content)
      if (usedTokens + tokens <= TOKEN_BUDGET) {
        fileContents.push({ path: filePath, content })
        usedTokens += tokens
      }
    }
  }

  const nodeContent = [
    `节点：${nodeTitle}`,
    `类型：${nodeType}`,
    `关联文件数：${fileContents.length}`,
    '',
    ...fileContents.map((f) => `--- ${f.path} ---\n${f.content}`),
  ].join('\n')

  return {
    nodeContent,
    relatedFileContents: fileContents,
    tokenEstimate: usedTokens + estimateTokens(`节点：${nodeTitle}\n类型：${nodeType}`),
  }
}

/**
 * 根据节点名搜索相关文件
 */
async function searchByNodeTitle(
  projectPath: string,
  nodeTitle: string,
  _nodeType: NodeType,
): Promise<Array<{ filePath: string; content: string }>> {
  const results: Array<{ filePath: string; content: string }> = []
  const keywords = nodeTitle.split(/[·\-_\s/\\]+/).filter((k) => k.length > 1)

  if (keywords.length === 0) return results

  const srcDir = path.join(projectPath, 'src')
  try {
    await walkAndMatch(srcDir, keywords, results, 0)
  } catch {
    // src 目录不存在
  }

  return results.slice(0, 5)
}

async function walkAndMatch(
  dir: string,
  keywords: string[],
  results: Array<{ filePath: string; content: string }>,
  depth: number,
): Promise<void> {
  if (depth > 4 || results.length >= 5) return

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
  for (const entry of entries) {
    if (results.length >= 5) break
    if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue

    if (entry.isDirectory()) {
      // 目录名匹配关键词
      if (keywords.some((k) => entry.name.toLowerCase().includes(k.toLowerCase()))) {
        // 读取该目录的 index 文件
        for (const indexName of ['index.ts', 'index.tsx', 'index.js', '__init__.py']) {
          try {
            const content = await fs.readFile(path.join(dir, entry.name, indexName), 'utf-8')
            results.push({
              filePath: path.relative(path.dirname(dir), path.join(dir, entry.name, indexName)),
              content: content.substring(0, 2000),
            })
            break
          } catch {
            // 没有 index 文件
          }
        }
      }
      await walkAndMatch(path.join(dir, entry.name), keywords, results, depth + 1)
    } else if (entry.isFile()) {
      // 文件名匹配关键词
      if (keywords.some((k) => entry.name.toLowerCase().includes(k.toLowerCase()))) {
        try {
          const content = await fs.readFile(path.join(dir, entry.name), 'utf-8')
          results.push({
            filePath: path.relative(path.dirname(dir), path.join(dir, entry.name)),
            content: content.substring(0, 2000),
          })
        } catch {
          // 无法读取
        }
      }
    }
  }
}
