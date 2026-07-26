/**
 * LLM 提炼式导入服务
 *
 * 与规则式 IngestService 差异仅在内容来源：原文经 LLM 提炼为
 * 带 frontmatter 与建议 wikilink 的 wiki 页。同名追加、draft 新建、
 * 落边等落库语义完全复用规则式。AgentRunner 由 IPC 层注入
 * （sendPromptViaAgent），测试替换为 stub。
 */

import type { GraphType } from '@shared/types'
import type { IngestResult } from '@shared/types/wiki'
import { basename } from 'path'
import { parseWikiMarkdown, normalizeWikiTitle } from './markdown-utils'
import { IngestService, type IngestNodeRepo, type IngestEdgeRepo, type ReadFileFn } from './ingest-service'
import { IpcError, ErrorCode } from '../errors'

export type AgentRunner = (prompt: string) => Promise<string>

const MAX_EXISTING_TITLES = 200

/** LLM 提炼模式单文件大小上限（200 KB）。超过的文件记入 failed，不发给 agent。 */
export const MAX_LLM_FILE_SIZE = 200 * 1024

function fileBaseName(filePath: string): string {
  return basename(filePath).replace(/\.(md|markdown|txt)$/i, '')
}

function buildPrompt(raw: string, sourcePath: string, existingTitles: string[]): string {
  const titleList = existingTitles.slice(0, MAX_EXISTING_TITLES).map((t) => `- ${t}`).join('\n')
  return `你是知识工程师。把下面的原始资料提炼为一页 wiki 页面。

要求：
1. 第一行输出 YAML frontmatter（--- 包裹），必须含 title 字段。
2. frontmatter 之后输出 markdown 正文，首行为与 title 一致的 H1。
3. 正文中用 [[标题]] 形式引用相关概念；优先引用下列已有页面标题（逐字使用）：
${titleList || '（无）'}
4. 只输出 markdown，不要任何解释。

原始资料（来源：${sourcePath}）：

${raw}`
}

function processLlmOutput(output: string, filePath: string): { filePath: string; markdown: string; warning?: string } {
  let markdown = output
  let warning: string | undefined
  try {
    parseWikiMarkdown(output)
  } catch {
    warning = 'LLM 输出 frontmatter 无法解析，已回退为文件名标题 + 原文整体导入'
    const safeBody = output.replace(/^---\r?\n[\s\S]*?\r?\n---\r?/, '').trim()
    markdown = `# ${normalizeWikiTitle(fileBaseName(filePath))}\n\n${safeBody}`
  }
  return { filePath, markdown, ...(warning ? { warning } : {}) }
}

export class LlmIngestService {
  static async ingestWithLlm(
    graphId: string,
    filePaths: string[],
    graphType: GraphType,
    nodeRepo: IngestNodeRepo,
    edgeRepo: IngestEdgeRepo,
    readFile: ReadFileFn,
    agentRunner: AgentRunner,
  ): Promise<IngestResult> {
    const existingTitles = nodeRepo
      .listByGraph(graphId)
      .filter((n) => n.type === 'wiki-page')
      .map((n) => n.title)

    const refined: Array<{ filePath: string; markdown: string; warning?: string }> = []
    const result: IngestResult = { created: [], updated: [], failed: [] }

    // Agent 可用性探测：对第一个文件跑一次 agentRunner，成功即复用结果；
    // 若失败且属于 session/adapter 级错误，则整单失败，避免每个文件重复报同一错误。
    let agentAvailable = false

    for (const filePath of filePaths) {
      try {
        const raw = await readFile(filePath)
        if (raw.length > MAX_LLM_FILE_SIZE) {
          result.failed.push({ file: filePath, error: `文件超过 LLM 提炼上限 ${MAX_LLM_FILE_SIZE} 字节` })
          continue
        }

        if (!agentAvailable) {
          try {
            const output = await agentRunner(buildPrompt(raw, filePath, existingTitles))
            agentAvailable = true
            refined.push(processLlmOutput(output, filePath))
            continue
          } catch (err) {
            throw new IpcError(
              `LLM 不可用，请改用规则式导入：${err instanceof Error ? err.message : String(err)}`,
              ErrorCode.AGENT_ADAPTER_ERROR,
            )
          }
        }

        const output = await agentRunner(buildPrompt(raw, filePath, existingTitles))
        refined.push(processLlmOutput(output, filePath))
      } catch (err) {
        if (err instanceof IpcError && err.code === ErrorCode.AGENT_ADAPTER_ERROR) {
          throw err
        }
        result.failed.push({ file: filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }

    for (const item of refined) {
      try {
        const r = await IngestService.ingestFiles(
          graphId, [item.filePath], graphType, nodeRepo, edgeRepo,
          async () => item.markdown,
        )
        result.created.push(...r.created)
        result.updated.push(...r.updated)
        result.failed.push(...r.failed)
        const id = r.created[0]?.id ?? r.updated[0]?.id
        if (id && item.warning) {
          const n = nodeRepo.findById(id)
          if (n) nodeRepo.update(id, { wikiMeta: { ...(n.wikiMeta ?? {}), ingestWarning: item.warning } })
        }
      } catch (err) {
        result.failed.push({ file: item.filePath, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return result
  }
}
