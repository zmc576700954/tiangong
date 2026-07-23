/**
 * IngestService 测试
 * 文件内容通过 readFile 注入，不触碰真实文件系统；
 * repo 用内存 fake（模式同 wiki-index-service.test.ts）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { GraphEdge, GraphNode } from '@shared/types'
import { IngestService, type IngestNodeRepo, type IngestEdgeRepo } from '../ingest-service'
import { generateId } from '../../shared/env'

function createFakeRepos() {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const nodeRepo: IngestNodeRepo = {
    findById: (id) => nodes.find((n) => n.id === id) ?? null,
    listByGraph: (graphId) => nodes.filter((n) => n.graphId === graphId),
    create(data) {
      const now = new Date().toISOString()
      const node: GraphNode = { ...data, id: generateId('node'), createdAt: now, updatedAt: now }
      nodes.push(node)
      return node
    },
    update(id, data) {
      const idx = nodes.findIndex((n) => n.id === id)
      if (idx === -1) throw new Error(`Node not found: ${id}`)
      nodes[idx] = { ...nodes[idx], ...data, updatedAt: new Date().toISOString() }
      return nodes[idx]
    },
  }
  const edgeRepo: IngestEdgeRepo = {
    create(data) {
      const edge: GraphEdge = { ...data, id: generateId('edge') }
      edges.push(edge)
      return edge
    },
    delete(id) {
      const idx = edges.findIndex((e) => e.id === id)
      if (idx !== -1) edges.splice(idx, 1)
    },
    listByGraph: (graphId) => edges.filter((e) => e.graphId === graphId),
  }
  return { nodeRepo, edgeRepo, nodes, edges }
}

function makeReadFile(files: Record<string, string>): (p: string) => Promise<string> {
  return async (p) => {
    if (p in files) return files[p]
    throw new Error(`ENOENT: ${p}`)
  }
}

describe('IngestService.ingestFiles', () => {
  let f: ReturnType<typeof createFakeRepos>
  beforeEach(() => { f = createFakeRepos() })

  it('导入新文件创建 draft wiki-page 节点', async () => {
    const result = await IngestService.ingestFiles(
      'g1', ['/docs/支付流程.md'], 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile({ '/docs/支付流程.md': '# 支付流程\n\n下单后扣款。' }),
    )

    expect(result.created).toHaveLength(1)
    expect(result.created[0].title).toBe('支付流程')
    expect(result.failed).toEqual([])
    const node = f.nodes.find((n) => n.title === '支付流程')!
    expect(node.status).toBe('draft')
    expect(node.wikiContent).toContain('# 支付流程')
    expect(node.wikiMeta?.sourceFile).toBe('/docs/支付流程.md')
    expect(node.wikiMeta?.importedAt).toBeTruthy()
  })

  it('标题优先级：frontmatter.title > H1 > 文件名', async () => {
    const files = {
      '/a.md': '---\ntitle: FM标题\n---\n# H1标题\n\n内容',
      '/b.md': '# H1标题\n\n内容',
      '/c-文件.md': '无标题正文',
    }
    const result = await IngestService.ingestFiles(
      'g1', Object.keys(files), 'online', f.nodeRepo, f.edgeRepo, makeReadFile(files),
    )

    const titles = result.created.map((c) => c.title).sort()
    expect(titles).toEqual(['FM标题', 'H1标题', 'c-文件'])
  })

  it('同名已有页面时追加内容并标注来源', async () => {
    // 先导入一次
    await IngestService.ingestFiles('g1', ['/a.md'], 'online', f.nodeRepo, f.edgeRepo,
      makeReadFile({ '/a.md': '# 页面A\n\n第一版' }))
    // 再导入同名新版
    const result = await IngestService.ingestFiles('g1', ['/a-v2.md'], 'online', f.nodeRepo, f.edgeRepo,
      makeReadFile({ '/a-v2.md': '# 页面A\n\n第二版' }))

    expect(result.created).toHaveLength(0)
    expect(result.updated).toHaveLength(1)
    const node = f.nodes.find((n) => n.title === '页面A')!
    expect(node.wikiContent).toContain('第一版')
    expect(node.wikiContent).toContain('第二版')
    expect(node.wikiContent).toMatch(/导入自 .*a-v2\.md/)
    expect(f.nodes.filter((n) => n.title === '页面A')).toHaveLength(1)
  })

  it('批量导入先建节点后统一落边，同批互链可解析', async () => {
    const files = {
      '/a.md': '# 页面A\n\n见 [[页面B]]',
      '/b.md': '# 页面B\n\n回链 [[页面A]]',
    }
    await IngestService.ingestFiles('g1', Object.keys(files), 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile(files))

    const a = f.nodes.find((n) => n.title === '页面A')!
    const b = f.nodes.find((n) => n.title === '页面B')!
    expect(f.edges).toHaveLength(2)
    expect(f.edges.some((e) => e.source === a.id && e.target === b.id && e.edgeType === 'wiki-link')).toBe(true)
    expect(f.edges.some((e) => e.source === b.id && e.target === a.id && e.edgeType === 'wiki-link')).toBe(true)
  })

  it('单文件失败不阻塞整批', async () => {
    const result = await IngestService.ingestFiles(
      'g1', ['/good.md', '/missing.md'], 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile({ '/good.md': '# 好页面' }),
    )

    expect(result.created).toHaveLength(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].file).toBe('/missing.md')
    expect(result.failed[0].error).toContain('ENOENT')
  })

  it('接受绝对路径文件名回退（跨平台分隔符）', async () => {
    // 构造平台相关的绝对路径，验证 basename 与扩展名剥离
    const sep = process.platform === 'win32' ? '\\' : '/'
    const filePath = ['', 'docs', '我的页面.md'].join(sep).replace(/^\\/, 'C:\\')
    const result = await IngestService.ingestFiles(
      'g1', [filePath], 'online', f.nodeRepo, f.edgeRepo,
      makeReadFile({ [filePath]: '无标题正文' }),
    )

    expect(result.created[0]?.title).toBe('我的页面')
  })

  it('frontmatter YAML 错误的文件计入 failed', async () => {
    const result = await IngestService.ingestFiles(
      'g1', ['/bad.md'], 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile({ '/bad.md': '---\n: 非法yaml: [\n---\n正文' }),
    )

    expect(result.created).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
  })

  it('导入节点位置按网格铺开', async () => {
    const files = { '/a.md': '# A', '/b.md': '# B', '/c.md': '# C', '/d.md': '# D' }
    await IngestService.ingestFiles('g1', Object.keys(files), 'online',
      f.nodeRepo, f.edgeRepo, makeReadFile(files))

    const positions = f.nodes.map((n) => `${n.position.x},${n.position.y}`)
    expect(new Set(positions).size).toBe(f.nodes.length)  // 无堆叠
  })
})
