import { describe, it, expect, beforeEach } from 'vitest'
import { WritebackService, type WritebackRepoLike, type NodeTitleSource } from '../writeback-service'
import type { MemoryItem } from '@shared/types'
import type { WritebackItem } from '@shared/types/wiki'

function mem(over: Partial<MemoryItem>): Omit<MemoryItem, 'id'> {
  return {
    session_id: 'sess_1', kind: 'discovery', project_id: 'g1', node_id: 'n1',
    title: '默认标题', narrative: 'narrative', facts: [], concepts: [],
    files_read: [], files_modified: [], adapter_name: 'claude-code',
    token_cost: 100, confidence: 0.8, created_at: '2026-07-30T00:00:00Z',
    ...over,
  } as Omit<MemoryItem, 'id'>
}

// fake writeback repo（纯内存，验证生成逻辑，不碰 DB）
function fakeWritebackRepo(): WritebackRepoLike & { items: WritebackItem[] } {
  const items: WritebackItem[] = []
  return {
    items,
    create: (d: Omit<WritebackItem, 'id' | 'status' | 'createdAt' | 'resolvedAt'>) => {
      const it: WritebackItem = {
        ...d,
        id: `writeback-${items.length}`,
        status: 'pending',
        createdAt: 'now',
        resolvedAt: null,
      }
      items.push(it)
      return it
    },
    findBySession: (sid: string) => items.filter((i) => i.sourceSessionId === sid),
    findById: (id: string) => items.find((i) => i.id === id) ?? null,
    updateStatus: (id: string, status: WritebackItem['status']) => {
      const it = items.find((i) => i.id === id)
      if (it) it.status = status
    },
  }
}

function fakeTitleSource(titles: string[] = []): NodeTitleSource {
  return { findExistingTitles: () => titles }
}

describe('WritebackService.generate', () => {
  let service: WritebackService
  let repo: ReturnType<typeof fakeWritebackRepo>
  beforeEach(() => {
    repo = fakeWritebackRepo()
    service = new WritebackService(repo, fakeTitleSource())
  })

  it('generates append-log item targeting nodeId with 会话日志 section', () => {
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'Node A', sessionId: 'sess_1', memories: [mem({ title: '发现 X' })] })
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('append-log')
    expect(out[0].targetNodeId).toBe('n1')
    expect(out[0].content).toContain('## 会话日志')
    expect(out[0].content).toContain('发现 X')
  })

  it('returns empty when memories empty', () => {
    expect(service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories: [] })).toEqual([])
  })

  it('skips generation when session already has pending/accepted items (dedup)', () => {
    service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 'sess_1', memories: [mem({})] })
    const again = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 'sess_1', memories: [mem({})] })
    expect(again).toEqual([])
  })

  it('truncates to top-5 memories by confidence and averages confidence', () => {
    const memories = Array.from({ length: 8 }, (_, i) => mem({ title: `m${i}`, confidence: (i + 1) / 10 }))
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    // top5 confidence: 0.8,0.7,0.6,0.5,0.4 → mean 0.6
    expect(out[0].confidence).toBeCloseTo(0.6)
  })

  it('generates new-page item when >=2 memories share a novel concept', () => {
    const memories = [
      mem({ title: 'A', concepts: ['auth-flow'], confidence: 0.9 }),
      mem({ title: 'B', concepts: ['auth-flow'], confidence: 0.9 }),
    ]
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    const np = out.find((i) => i.kind === 'new-page')
    expect(np).toBeDefined()
    expect(np!.content).toContain('auth-flow')
    expect(np!.targetNodeId).toBe('n1') // new-page 的 targetNodeId 存源节点 id
  })

  it('does NOT generate new-page when concept matches existing title', () => {
    const svc = new WritebackService(repo, fakeTitleSource(['auth-flow']))
    const memories = [mem({ concepts: ['auth-flow'] }), mem({ concepts: ['auth-flow'] })]
    const out = svc.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    expect(out.find((i) => i.kind === 'new-page')).toBeUndefined()
  })

  it('creates separate new-page clusters for overlapping concepts', () => {
    const memories = [
      mem({ title: 'M1', concepts: ['a', 'b'], confidence: 0.9 }),
      mem({ title: 'M2', concepts: ['a'], confidence: 0.8 }),
      mem({ title: 'M3', concepts: ['b'], confidence: 0.7 }),
    ]
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories })
    expect(out.some((i) => i.kind === 'append-log')).toBe(true)
    const newPages = out.filter((i) => i.kind === 'new-page')
    expect(newPages).toHaveLength(2)
    expect(newPages.map((i) => i.title).sort()).toEqual(['a', 'b'])
  })

  it('uses deterministic now for append-log title and section', () => {
    const now = new Date('2026-07-30T14:32:00Z')
    const out = service.generate({ graphId: 'g1', nodeId: 'n1', nodeTitle: 'A', sessionId: 's', memories: [mem({})] }, now)
    expect(out[0].title).toBe('会话日志 · 2026-07-30')
    expect(out[0].content).toContain('## 会话日志 · 2026-07-30 14:32')
  })

  it('escapes markdown injection in append-log content', () => {
    const out = service.generate({
      graphId: 'g1',
      nodeId: 'n1',
      nodeTitle: 'A',
      sessionId: 's',
      memories: [mem({
        title: '[[evil]] **bold**',
        narrative: 'narrative',
        facts: ['[[bad]] `code`'],
      })],
    })
    expect(out[0].content).not.toContain('[[evil]]')
    expect(out[0].content).not.toContain('[[bad]]')
  })
})
