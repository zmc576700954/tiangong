import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NodeRepository } from '../repositories/node-repository'
import type BetterSqlite3 from 'better-sqlite3'
import type { GraphNode } from '@shared/types'

function createMockDb() {
  const stmtMock = {
    run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
    get: vi.fn().mockReturnValue(null),
    all: vi.fn().mockReturnValue([]),
  }
  const db = {
    prepare: vi.fn().mockReturnValue(stmtMock),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args)),
    exec: vi.fn(),
    pragma: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as BetterSqlite3.Database & { _stmt: typeof stmtMock }
  ;(db as unknown as Record<string, unknown>)._stmt = stmtMock
  return { db, stmt: stmtMock }
}

function makeNodeData(): Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    type: 'feature',
    status: 'draft',
    title: 'N1',
    graphId: 'g1',
    graphType: 'online',
    position: { x: 0, y: 0 },
  }
}

describe('NodeRepository', () => {
  let db: BetterSqlite3.Database
  let stmt: ReturnType<typeof createMockDb>['stmt']
  let repo: NodeRepository

  beforeEach(() => {
    const mock = createMockDb()
    db = mock.db
    stmt = mock.stmt
    repo = new NodeRepository(db)
  })

  it('create inserts a node and returns it', () => {
    const node = repo.create(makeNodeData())
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO nodes'))
    expect(node.title).toBe('N1')
    expect(node.type).toBe('feature')
  })

  it('create persists content, communitySummary and communityLevel', () => {
    const content = { fullDescription: 'desc', implementationNotes: ['note1'] }
    const node = repo.create({
      ...makeNodeData(),
      content,
      communitySummary: 'summary',
      communityLevel: 1,
    })
    expect(node.content).toEqual(content)
    expect(node.communitySummary).toBe('summary')
    expect(node.communityLevel).toBe(1)

    const callArgs = stmt.run.mock.calls[0]
    expect(callArgs[14]).toBe(JSON.stringify(content)) // position_x=12, position_y=13, content=14
    expect(callArgs[15]).toBe('summary') // community_summary=15
    expect(callArgs[16]).toBe(1) // community_level=16
  })

  it('create persists wikiContent and wikiMeta', () => {
    const wikiMeta = { frontmatter: { title: 'X' }, role: 'index' as const }
    const node = repo.create({ ...makeNodeData(), wikiContent: '# Hello', wikiMeta })
    expect(node.wikiContent).toBe('# Hello')
    expect(node.wikiMeta).toEqual(wikiMeta)

    const callArgs = stmt.run.mock.calls[0]
    expect(callArgs[18]).toBe('# Hello') // wiki_content=18
    expect(callArgs[19]).toBe(JSON.stringify(wikiMeta)) // wiki_meta=19
  })

  it('create stores optional fields as null when omitted', () => {
    repo.create(makeNodeData())
    const callArgs = stmt.run.mock.calls[0]
    expect(callArgs[14]).toBeNull() // content
    expect(callArgs[15]).toBeNull() // community_summary
    expect(callArgs[16]).toBeNull() // community_level
    expect(callArgs[18]).toBeNull() // wiki_content
    expect(callArgs[19]).toBeNull() // wiki_meta
  })

  it('createBatch returns empty for empty input', () => {
    expect(repo.createBatch([])).toEqual([])
  })

  it('createBatch inserts multiple nodes in transaction', () => {
    const nodes = repo.createBatch([makeNodeData(), makeNodeData()])
    expect(nodes).toHaveLength(2)
    expect(db.transaction).toHaveBeenCalled()
  })

  it('update modifies node fields', () => {
    stmt.get.mockReturnValueOnce({
      id: 'n1', type: 'feature', status: 'confirmed', title: 'Updated', description: null, acceptance_criteria: null,
      graph_id: 'g1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
      content: null, community_summary: null, community_level: null,
      owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
    })
    const node = repo.update('n1', { status: 'confirmed', title: 'Updated' })
    expect(node.status).toBe('confirmed')
    expect(node.title).toBe('Updated')
  })

  it('update persists content, communitySummary and communityLevel', () => {
    const selectStmt = {
      run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
      get: vi.fn().mockReturnValue({
        id: 'n1', type: 'feature', status: 'draft', title: 'N1', description: null, acceptance_criteria: null,
        graph_id: 'g1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
        content: '{"fullDescription":"updated"}', community_summary: 'new summary', community_level: 2,
        wiki_content: null, wiki_meta: null,
        owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      }),
      all: vi.fn().mockReturnValue([]),
    }
    ;(db.prepare as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(stmt) // UPDATE prepare
      .mockReturnValueOnce(selectStmt) // SELECT prepare

    const content = { fullDescription: 'updated' }
    const node = repo.update('n1', { content, communitySummary: 'new summary', communityLevel: 2 })

    const updateSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateSql).toContain('content = ?')
    expect(updateSql).toContain('community_summary = ?')
    expect(updateSql).toContain('community_level = ?')

    const updateCallArgs = stmt.run.mock.calls[0]
    expect(updateCallArgs[0]).toBe(JSON.stringify(content))
    expect(updateCallArgs[1]).toBe('new summary')
    expect(updateCallArgs[2]).toBe(2)

    expect(node.content).toEqual(content)
    expect(node.communitySummary).toBe('new summary')
    expect(node.communityLevel).toBe(2)
  })

  it('update persists wikiContent and wikiMeta', () => {
    const wikiMeta = { frontmatter: { title: 'X' }, role: 'research' as const }
    const selectStmt = {
      run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
      get: vi.fn().mockReturnValue({
        id: 'n1', type: 'feature', status: 'draft', title: 'N1', description: null, acceptance_criteria: null,
        graph_id: 'g1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
        content: null, community_summary: null, community_level: null,
        wiki_content: '# Updated', wiki_meta: JSON.stringify(wikiMeta),
        owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      }),
      all: vi.fn().mockReturnValue([]),
    }
    ;(db.prepare as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(stmt) // UPDATE prepare
      .mockReturnValueOnce(selectStmt) // SELECT prepare

    const node = repo.update('n1', { wikiContent: '# Updated', wikiMeta })

    const updateSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(updateSql).toContain('wiki_content = ?')
    expect(updateSql).toContain('wiki_meta = ?')

    const updateCallArgs = stmt.run.mock.calls[0]
    expect(updateCallArgs[0]).toBe('# Updated')
    expect(updateCallArgs[1]).toBe(JSON.stringify(wikiMeta))

    expect(node.wikiContent).toBe('# Updated')
    expect(node.wikiMeta).toEqual(wikiMeta)
  })

  it('findById returns undefined for null content/community fields', () => {
    stmt.get.mockReturnValueOnce({
      id: 'n1', type: 'feature', status: 'draft', title: 'N1', description: null, acceptance_criteria: null,
      graph_id: 'g1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
      content: null, community_summary: null, community_level: null,
      wiki_content: null, wiki_meta: null,
      owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
    })
    const node = repo.findById('n1')
    expect(node).not.toBeNull()
    expect(node?.content).toBeUndefined()
    expect(node?.communitySummary).toBeUndefined()
    expect(node?.communityLevel).toBeUndefined()
    expect(node?.wikiContent).toBeUndefined()
    expect(node?.wikiMeta).toBeUndefined()
  })

  it('getStatus returns node status', () => {
    stmt.get.mockReturnValueOnce({ status: 'developing' })
    expect(repo.getStatus('n1')).toBe('developing')
  })

  it('findById returns null when not found', () => {
    expect(repo.findById('missing')).toBeNull()
  })

  it('delete removes node', () => {
    repo.delete('n1')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM nodes'))
  })

  it('batchUpdatePositions updates positions in transaction', () => {
    repo.batchUpdatePositions([{ id: 'n1', x: 10, y: 20 }])
    expect(db.transaction).toHaveBeenCalled()
  })
})
