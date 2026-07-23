/**
 * Wiki 特殊页服务测试
 * 使用内存中的 Fake NodeRepository 验证创建与解析逻辑，
 * 避免对 better-sqlite3 原生绑定的依赖。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { GraphNode } from '@shared/types'
import { WikiIndexService } from '../wiki-index-service'
import { GRAPH_INDEX_TITLE, GRAPH_LOG_TITLE } from '@shared/constants'
import { parseWikiMarkdown } from '../../wiki/markdown-utils'
import { generateId } from '../../shared/env'

type CreateInput = Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>

function createFakeRepo() {
  const nodes: GraphNode[] = []

  return {
    create(data: CreateInput): GraphNode {
      const now = new Date().toISOString()
      const node: GraphNode = {
        ...data,
        id: generateId('node'),
        createdAt: now,
        updatedAt: now,
      }
      nodes.push(node)
      return node
    },

    listByGraph(graphId: string): GraphNode[] {
      return nodes.filter((n) => n.graphId === graphId)
    },

    delete(id: string): void {
      const idx = nodes.findIndex((n) => n.id === id)
      if (idx !== -1) nodes.splice(idx, 1)
    },
  }
}

describe('WikiIndexService', () => {
  let repo: ReturnType<typeof createFakeRepo>

  beforeEach(() => {
    repo = createFakeRepo()
  })

  it('createSpecialPages creates index and log', async () => {
    const { indexId, logId } = await WikiIndexService.createSpecialPages('g1', 'online', repo)

    expect(indexId).toBeTruthy()
    expect(logId).toBeTruthy()
    expect(indexId).not.toBe(logId)

    const nodes = repo.listByGraph('g1')
    expect(nodes).toHaveLength(2)

    const index = nodes.find((n) => n.wikiMeta?.specialPage === 'index')
    const log = nodes.find((n) => n.wikiMeta?.specialPage === 'log')

    expect(index).toBeDefined()
    expect(log).toBeDefined()
    expect(index?.title).toBe(GRAPH_INDEX_TITLE)
    expect(log?.title).toBe(GRAPH_LOG_TITLE)

    const parsed = parseWikiMarkdown(index?.wikiContent ?? '')
    expect(parsed.frontmatter.title).toBe(GRAPH_INDEX_TITLE)
    expect(parsed.frontmatter.specialPage).toBe('index')
    expect(parsed.body).toContain(`[[${GRAPH_LOG_TITLE}]]`)
  })

  it('ensureSpecialPages is idempotent', async () => {
    const first = await WikiIndexService.ensureSpecialPages('g1', 'online', repo)
    const second = await WikiIndexService.ensureSpecialPages('g1', 'online', repo)

    expect(second.indexId).toBe(first.indexId)
    expect(second.logId).toBe(first.logId)
    expect(repo.listByGraph('g1')).toHaveLength(2)
  })

  it('ensureSpecialPages only fills missing pages', async () => {
    const { indexId } = await WikiIndexService.createSpecialPages('g1', 'online', repo)
    const log = repo.listByGraph('g1').find((n) => n.wikiMeta?.specialPage === 'log')
    if (log) {
      repo.delete(log.id)
    }
    expect(repo.listByGraph('g1')).toHaveLength(1)

    const ensured = await WikiIndexService.ensureSpecialPages('g1', 'online', repo)

    expect(ensured.indexId).toBe(indexId)
    expect(repo.listByGraph('g1')).toHaveLength(2)
  })

  it('resolveWikiLink returns node id by title', async () => {
    const { indexId } = await WikiIndexService.createSpecialPages('g1', 'online', repo)
    const resolved = await WikiIndexService.resolveWikiLink('g1', GRAPH_INDEX_TITLE, repo)
    expect(resolved).toBe(indexId)
  })

  it('resolveWikiLink normalizes target title', async () => {
    const { logId } = await WikiIndexService.createSpecialPages('g1', 'online', repo)
    const resolved = await WikiIndexService.resolveWikiLink('g1', '  graph   log  ', repo)
    expect(resolved).toBe(logId)
  })

  it('resolveWikiLink returns null when not found', async () => {
    const resolved = await WikiIndexService.resolveWikiLink('g1', 'Missing Page', repo)
    expect(resolved).toBeNull()
  })
})
