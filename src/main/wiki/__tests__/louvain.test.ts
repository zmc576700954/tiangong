import { describe, it, expect } from 'vitest'
import { louvain } from '../louvain'

function tri(ids: string[]): Array<{ source: string; target: string }> {
  return [
    { source: ids[0], target: ids[1] },
    { source: ids[1], target: ids[2] },
    { source: ids[0], target: ids[2] },
  ]
}

describe('louvain', () => {
  it('两个三角加一条桥边应分为 2 个社区', () => {
    const g = {
      nodeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      edges: [...tri(['a', 'b', 'c']), ...tri(['d', 'e', 'f']), { source: 'c', target: 'd' }],
    }
    const r = louvain(g, { seed: 42 })
    expect(r.communities().length).toBe(2)
    expect(r.communityOf('a')).toBe(r.communityOf('b'))
    expect(r.communityOf('d')).toBe(r.communityOf('f'))
    expect(r.communityOf('a')).not.toBe(r.communityOf('d'))
  })

  it('空图返回 0 社区、模块度 0', () => {
    const r = louvain({ nodeIds: [], edges: [] })
    expect(r.communities().length).toBe(0)
    expect(r.modularity()).toBe(0)
  })

  it('无边节点各自成社区', () => {
    const r = louvain({ nodeIds: ['x', 'y', 'z'], edges: [] })
    expect(r.communities().length).toBe(3)
  })

  it('固定 seed 结果可复现', () => {
    const g = {
      nodeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
      edges: [...tri(['a', 'b', 'c']), ...tri(['d', 'e', 'f']), { source: 'c', target: 'd' }],
    }
    const r1 = louvain(g, { seed: 7 })
    const r2 = louvain(g, { seed: 7 })
    g.nodeIds.forEach((id) => expect(r1.communityOf(id)).toBe(r2.communityOf(id)))
    expect(r1.modularity()).toBeCloseTo(r2.modularity(), 10)
  })

  it('communityOf 对未知节点返回 undefined 行为外的自身社区', () => {
    const r = louvain({ nodeIds: ['a'], edges: [] })
    expect(r.communityOf('a')).toBeDefined()
  })

  it('悬空边（引用不存在节点）被过滤不报错', () => {
    const r = louvain({ nodeIds: ['a', 'b'], edges: [{ source: 'a', target: 'ghost' }] })
    expect(r.communityOf('a')).toBeDefined()
    expect(r.communityOf('b')).toBeDefined()
  })

  it('1000 节点玩具图在 2 秒内完成', () => {
    const nodeIds = Array.from({ length: 1000 }, (_, i) => `n${i}`)
    const edges: Array<{ source: string; target: string }> = []
    for (let c = 0; c < 20; c++) {
      const base = c * 50
      for (let i = 0; i < 50; i++) {
        edges.push({ source: `n${base + i}`, target: `n${base + ((i + 1) % 50)}` })
        edges.push({ source: `n${base + i}`, target: `n${base + ((i + 2) % 50)}` })
      }
      edges.push({ source: `n${base}`, target: `n${(base + 50) % 1000}` })
    }
    const start = Date.now()
    louvain({ nodeIds, edges }, { seed: 1 })
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
