/**
 * WikiLinkService 测试
 * 使用内存 fake repo（不依赖 better-sqlite3），模式同 wiki-index-service.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { GraphEdge, GraphNode } from '@shared/types'
import { WikiLinkService, type WikiNodeRepo, type WikiEdgeRepo } from '../wiki-link-service'
import { generateId } from '../../shared/env'

type CreateNodeInput = Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>

function createFakeRepos() {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const nodeRepo: WikiNodeRepo = {
    findById: (id) => nodes.find((n) => n.id === id) ?? null,
    listByGraph: (graphId) => nodes.filter((n) => n.graphId === graphId),
  }
  const edgeRepo: WikiEdgeRepo = {
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

  function addWikiPage(title: string, wikiContent: string, graphId = 'g1'): GraphNode {
    const now = new Date().toISOString()
    const data: CreateNodeInput = {
      type: 'wiki-page', status: 'draft', title, graphId, graphType: 'online',
      position: { x: 0, y: 0 }, wikiContent,
    }
    const node: GraphNode = { ...data, id: generateId('node'), createdAt: now, updatedAt: now }
    nodes.push(node)
    return node
  }

  return { nodeRepo, edgeRepo, nodes, edges, addWikiPage }
}

describe('WikiLinkService.syncNodeLinks', () => {
  let f: ReturnType<typeof createFakeRepos>
  beforeEach(() => { f = createFakeRepos() })

  it('为已解析的 wikilink 创建 wiki-link 边，悬空链接不落库', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '# B\n\n参见 [[页面A]] 和 [[不存在页]]')

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.added).toHaveLength(1)
    expect(result.added[0].edgeType).toBe('wiki-link')
    expect(result.added[0].source).toBe(b.id)
    expect(result.dangling).toEqual(['不存在页'])
    expect(f.edges).toHaveLength(1)
  })

  it('重复同步幂等：内容不变时不增删边', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    const second = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(second.added).toHaveLength(0)
    expect(second.removed).toHaveLength(0)
    expect(f.edges).toHaveLength(1)
  })

  it('内容更新后 diff 增删边', () => {
    const a = f.addWikiPage('页面A', '# A')
    const c = f.addWikiPage('页面C', '# C')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    // 模拟 node:update：先改内容再同步
    b.wikiContent = '[[页面C]]'
    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(1)
    expect(result.added[0].target).toBe(c.id)
    expect(f.edges).toHaveLength(1)
    expect(f.edges[0].target).toBe(c.id)
    expect(f.edges[0].target).not.toBe(a.id)
  })

  it('支持 [[目标|显示文本]] 别名与标题归一化', () => {
    f.addWikiPage('Graph Log', '# Log')
    const b = f.addWikiPage('页面B', '见 [[graph　log|日志页]]')  // 全角空格+大小写差异

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.added).toHaveLength(1)
    expect(result.dangling).toEqual([])
  })

  it('跳过代码块内的 [[link]]', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '```\n[[页面A]]\n```\n正文无链接')

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.added).toHaveLength(0)
    expect(result.dangling).toEqual([])
  })

  it('自链接创建自环边，非 wiki-page 节点返回空结果', () => {
    const b = f.addWikiPage('页面B', '自引 [[页面B]]')
    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)
    expect(result.added).toHaveLength(1)
    expect(result.added[0].target).toBe(b.id)

    const feature: GraphNode = {
      id: 'feat-1', type: 'feature', status: 'draft', title: 'F',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      createdAt: '', updatedAt: '',
    }
    f.nodes.push(feature)
    const r2 = WikiLinkService.syncNodeLinks('feat-1', f.nodeRepo, f.edgeRepo)
    expect(r2).toEqual({ added: [], removed: [], dangling: [] })
  })
})

describe('WikiLinkService.parseContent / getBacklinks / findDanglingLinks', () => {
  let f: ReturnType<typeof createFakeRepos>
  beforeEach(() => { f = createFakeRepos() })

  it('parseContent 返回 frontmatter、title 与带 resolved 标记的链接', () => {
    const a = f.addWikiPage('页面A', '# A')
    const parsed = WikiLinkService.parseContent(
      'g1',
      '---\ntags:\n  - x\n---\n# 标题\n\n[[页面A|别名]] [[缺失]]',
      f.nodeRepo,
    )

    expect(parsed.frontmatter).toEqual({ tags: ['x'] })
    expect(parsed.title).toBe('标题')
    expect(parsed.links).toHaveLength(2)
    expect(parsed.links[0]).toMatchObject({ targetTitle: '页面A', displayText: '别名', resolved: true, nodeId: a.id })
    expect(parsed.links[1]).toMatchObject({ targetTitle: '缺失', resolved: false })
  })

  it('getBacklinks 返回指向目标节点的源页面', () => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    const a = f.nodes.find((n) => n.title === '页面A')!
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    const backlinks = WikiLinkService.getBacklinks(a.id, f.nodeRepo, f.edgeRepo)

    expect(backlinks).toHaveLength(1)
    expect(backlinks[0].id).toBe(b.id)
  })

  it('findDanglingLinks 汇总全图悬空链接', () => {
    f.addWikiPage('页面A', '[[缺失1]]')
    f.addWikiPage('页面B', '[[缺失2]] [[缺失1]]')

    const dangling = WikiLinkService.findDanglingLinks('g1', f.nodeRepo)

    expect(dangling).toHaveLength(3)
    expect(dangling.map((d) => d.targetTitle).sort()).toEqual(['缺失1', '缺失1', '缺失2'])
    expect(dangling[0]).toHaveProperty('fromNodeId')
    expect(dangling[0]).toHaveProperty('fromTitle')
  })

  it('getBacklinks 目标节点不存在时返回空数组', () => {
    const backlinks = WikiLinkService.getBacklinks('node-missing', f.nodeRepo, f.edgeRepo)

    expect(backlinks).toEqual([])
  })

  it.each(['', undefined])('wikiContent 清空后 syncNodeLinks 移除该节点所有既有 wiki-link 出边', (cleared) => {
    f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '[[页面A]]')
    WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)
    expect(f.edges).toHaveLength(1)

    b.wikiContent = cleared
    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)

    expect(result.removed).toHaveLength(1)
    expect(result.added).toHaveLength(0)
    expect(f.edges).toHaveLength(0)
  })

  it('findDanglingLinks 对空图返回空数组', () => {
    expect(WikiLinkService.findDanglingLinks('g-empty', f.nodeRepo)).toEqual([])
  })

  it('getBacklinks 去重：同一源页面多条 wiki-link 边指向同一目标只算一次', () => {
    const a = f.addWikiPage('页面A', '# A')
    const b = f.addWikiPage('页面B', '# B')

    // 手动插入两条重复的 wiki-link 边：B → A
    f.edges.push(
      { id: generateId('edge'), source: b.id, target: a.id, edgeType: 'wiki-link', graphId: 'g1' },
      { id: generateId('edge'), source: b.id, target: a.id, edgeType: 'wiki-link', graphId: 'g1' },
    )

    const backlinks = WikiLinkService.getBacklinks(a.id, f.nodeRepo, f.edgeRepo)
    // 两条边都来自 B，但 B 只算一个
    expect(backlinks).toHaveLength(1)
    expect(backlinks[0].id).toBe(b.id)
  })

  it('标题大小写不敏感解析（同图）', () => {
    f.addWikiPage('Graph Log', '# Log')
    const b = f.addWikiPage('页面B', '见 [[GRAPH LOG]]')

    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)
    expect(result.added).toHaveLength(1)
    expect(result.dangling).toEqual([])
  })

  it('跨命名空间解析：同图不同标题前缀（wiki/foo vs project/foo）会被作为独立页面', () => {
    const wikiFoo = f.addWikiPage('wiki/foo', '# wiki/foo')
    const projectFoo = f.addWikiPage('project/foo', '# project/foo')

    expect(wikiFoo.id).not.toBe(projectFoo.id)

    // wikilink 指向 wiki/foo 时不应匹配到 project/foo
    const b = f.addWikiPage('b', '见 [[wiki/foo]]')
    const result = WikiLinkService.syncNodeLinks(b.id, f.nodeRepo, f.edgeRepo)
    expect(result.added).toHaveLength(1)
    expect(result.added[0].target).toBe(wikiFoo.id)
  })

  it('findDanglingLinks 跳过非 wiki-page 节点的 wikiContent', () => {
    // 模拟一个 feature 节点带 wikiContent（不应该被扫描）
    const feature: GraphNode = {
      id: 'feat-x', type: 'feature', status: 'draft', title: 'X',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      createdAt: '', updatedAt: '',
      wikiContent: '见 [[不应该被扫描]]',
    }
    f.nodes.push(feature)

    const dangling = WikiLinkService.findDanglingLinks('g1', f.nodeRepo)
    // feature 不在扫描范围
    expect(dangling).toEqual([])
  })

  it('parseContent 标题大小写不敏感，节点标题与 wikilink 大小写不一致也能解析', () => {
    const a = f.addWikiPage('MyPage', '# MyPage')
    const parsed = WikiLinkService.parseContent(
      'g1',
      '见 [[mypage]]',
      f.nodeRepo,
    )
    expect(parsed.links).toHaveLength(1)
    expect(parsed.links[0]).toMatchObject({ targetTitle: 'mypage', resolved: true, nodeId: a.id })
  })

  it('parseContent 对同一目标标题多次出现去重', () => {
    f.addWikiPage('A', '# A')
    const parsed = WikiLinkService.parseContent(
      'g1',
      '见 [[A]] 和 [[A]] 和 [[a]]',
      f.nodeRepo,
    )
    // 三个 wikilink 解析到同一个 A，但 links 列表里去重
    expect(parsed.links).toHaveLength(1)
  })
})
