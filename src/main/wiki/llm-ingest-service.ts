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

export type AgentRunner = (prompt: string) => Promise<string>

const MAX_EXISTING_TITLES = 200

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

    for (const filePath of filePaths) {
      try {
        const raw = await readFile(filePath)
        const output = await agentRunner(buildPrompt(raw, filePath, existingTitles))
        let markdown = output
        let warning: string | undefined
        try {
          parseWikiMarkdown(output)
        } catch {
          warning = 'LLM 输出 frontmatter 无法解析，已回退为文件名标题 + 原文整体导入'
          const safeBody = output.replace(/^---\r?\n[\s\S]*?\r?\n---\r?/, '').trim()
          markdown = `# ${normalizeWikiTitle(fileBaseName(filePath))}\n\n${safeBody}`
        }
        refined.push({ filePath, markdown, ...(warning ? { warning } : {}) })
      } catch (err) {
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
