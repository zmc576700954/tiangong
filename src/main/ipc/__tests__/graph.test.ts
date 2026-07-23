import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerGraphHandlers } from '../graph'
import type { GraphService } from '../../services/graph-service'
import type { SnapshotRepository } from '../../repositories/snapshot-repository'
import { nodeTypeRegistry } from '../../shared/node-type-registry'
import type BetterSqlite3 from 'better-sqlite3'
import type { TypedHandle } from '../utils'

import { IpcError } from '../../errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('registerGraphHandlers', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let graphService: GraphService
  let snapshotRepo: SnapshotRepository
  let db: BetterSqlite3.Database
  let stmtMock: { run: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; all: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    handlers = {}
    graphService = {
      createGraph: vi.fn().mockResolvedValue({ id: 'graph-1' }),
      listGraphs: vi.fn().mockResolvedValue([]),
      getGraph: vi.fn().mockResolvedValue(null),
      deleteGraph: vi.fn().mockResolvedValue(undefined),
      deriveGraph: vi.fn().mockResolvedValue({ id: 'graph-2' }),
    } as unknown as GraphService
    snapshotRepo = {
      create: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
      listByGraph: vi.fn().mockResolvedValue([]),
      load: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as SnapshotRepository
    stmtMock = {
      run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    }
    db = {
      prepare: vi.fn().mockReturnValue(stmtMock),
      transaction: vi.fn((fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => fn(...args)),
      exec: vi.fn(),
      pragma: vi.fn().mockReturnValue([]),
      close: vi.fn(),
    } as unknown as BetterSqlite3.Database

    const typedHandle: TypedHandle = (channel, handler) => {
      handlers[channel] = handler as (...args: any[]) => Promise<unknown>
    }

    registerGraphHandlers(db, typedHandle, graphService, snapshotRepo)
  })

  describe('node:create', () => {
    it('rejects node without required fields', async () => {
      await expect(handlers['node:create']({}, { type: 'module' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects node with invalid status', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'unknown',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      })).rejects.toThrow(IpcError)
    })

    it('rejects node with invalid graphType', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'invalid',
        position: { x: 0, y: 0 },
      })).rejects.toThrow(IpcError)
    })

    it('rejects node with missing position coordinates', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: '0' },
      })).rejects.toThrow(IpcError)
    })

    it('rejects node with overly long title', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'a'.repeat(201),
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      })).rejects.toThrow(IpcError)
    })

    it('creates a valid node', async () => {
      const data = {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      }
      await expect(handlers['node:create']({}, data)).resolves.not.toThrow()
    })

    it('accepts registered extension node types', async () => {
      nodeTypeRegistry.register({ type: 'custom-type', label: 'Custom' })
      const data = {
        type: 'custom-type',
        status: 'confirmed',
        title: 'Custom Node',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      }
      await expect(handlers['node:create']({}, data)).resolves.not.toThrow()
    })

    it('creates a valid node with optional community fields', async () => {
      const data = {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        content: { fullDescription: 'full' },
        communitySummary: 'summary',
        communityLevel: 1,
      }
      await expect(handlers['node:create']({}, data)).resolves.not.toThrow()
    })

    it('creates a valid node with wiki fields', async () => {
      const data = {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        wikiContent: '# Wiki',
        wikiMeta: { frontmatter: { title: 'Wiki' }, role: 'index' },
      }
      await expect(handlers['node:create']({}, data)).resolves.not.toThrow()
    })

    it('rejects non-string wikiContent', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        wikiContent: 123,
      })).rejects.toThrow(IpcError)
    })

    it('rejects non-object wikiMeta', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        wikiMeta: 'not-an-object',
      })).rejects.toThrow(IpcError)
    })

    it('rejects non-object content', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        content: 'not-an-object',
      })).rejects.toThrow(IpcError)
    })

    it('rejects non-string communitySummary', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        communitySummary: 123,
      })).rejects.toThrow(IpcError)
    })

    it('rejects non-number communityLevel', async () => {
      await expect(handlers['node:create']({}, {
        type: 'module',
        status: 'confirmed',
        title: 'Module',
        graphId: 'graph-1',
        graphType: 'online',
        position: { x: 0, y: 0 },
        communityLevel: '1',
      })).rejects.toThrow(IpcError)
    })
  })

  describe('node:createBatch', () => {
    it('rejects non-array input', async () => {
      await expect(handlers['node:createBatch']({}, { type: 'module' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects batch with invalid node', async () => {
      const nodes = [
        { type: 'module', status: 'confirmed', title: 'OK', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } },
        { type: 'invalid', status: 'confirmed', title: 'Bad', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } },
      ]
      await expect(handlers['node:createBatch']({}, nodes))
        .rejects.toThrow(IpcError)
    })
  })

  describe('node:update', () => {
    it('rejects empty title', async () => {
      await expect(handlers['node:update']({}, 'node-1', { title: '' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects overly long description', async () => {
      await expect(handlers['node:update']({}, 'node-1', { description: 'a'.repeat(2001) }))
        .rejects.toThrow(IpcError)
    })

    it('rejects invalid status update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { status: 'bad-status' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects non-object content update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { content: 'invalid' }))
        .rejects.toThrow(IpcError)
    })

    it('rejects non-string communitySummary update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { communitySummary: 123 }))
        .rejects.toThrow(IpcError)
    })

    it('rejects non-number communityLevel update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { communityLevel: '1' }))
        .rejects.toThrow(IpcError)
    })

    it('accepts valid community fields update', async () => {
      stmtMock.get.mockReturnValueOnce({
        id: 'node-1', type: 'feature', status: 'draft', title: 'N1', description: null, acceptance_criteria: null,
        graph_id: 'graph-1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
        content: '{"fullDescription":"updated"}', community_summary: 'new summary', community_level: 2,
        wiki_content: null, wiki_meta: null,
        owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      })
      await expect(handlers['node:update']({}, 'node-1', {
        content: { fullDescription: 'updated' },
        communitySummary: 'new summary',
        communityLevel: 2,
      })).resolves.not.toThrow()
    })

    it('accepts valid wiki fields update', async () => {
      stmtMock.get.mockReturnValueOnce({
        id: 'node-1', type: 'wiki-page', status: 'draft', title: 'Wiki', description: null, acceptance_criteria: null,
        graph_id: 'graph-1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
        content: null, community_summary: null, community_level: null,
        wiki_content: '# Updated', wiki_meta: '{"frontmatter":{"title":"Updated"},"role":"research"}',
        owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      })
      await expect(handlers['node:update']({}, 'node-1', {
        wikiContent: '# Updated',
        wikiMeta: { frontmatter: { title: 'Updated' }, role: 'research' },
      })).resolves.not.toThrow()
    })

    it('rejects non-string wikiContent update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { wikiContent: 123 }))
        .rejects.toThrow(IpcError)
    })

    it('rejects non-object wikiMeta update', async () => {
      await expect(handlers['node:update']({}, 'node-1', { wikiMeta: 'invalid' }))
        .rejects.toThrow(IpcError)
    })

    it('accepts valid wikiContent update and triggers no error from sync', async () => {
      stmtMock.get.mockReturnValueOnce({
        id: 'node-1', type: 'wiki-page', status: 'draft', title: 'Wiki', description: null, acceptance_criteria: null,
        graph_id: 'graph-1', graph_type: 'online', parent_id: null, rules: null, metadata: null, context_refs: null,
        content: null, community_summary: null, community_level: null,
        wiki_content: '[[Some Page]]', wiki_meta: null,
        owner_role: null, position_x: 0, position_y: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
      })
      await expect(handlers['node:update']({}, 'node-1', { wikiContent: '[[Some Page]]' })).resolves.not.toThrow()
    })
  })

  describe('edge:create wiki-link guard', () => {
    it('rejects manual wiki-link edge creation', async () => {
      await expect(handlers['edge:create']({}, {
        source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'wiki-link',
      })).rejects.toThrow(IpcError)
    })

    it('allows business edge creation', async () => {
      await expect(handlers['edge:create']({}, {
        source: 'n1', target: 'n2', graphId: 'g1', edgeType: 'default',
      })).resolves.not.toThrow()
    })
  })

  describe('wiki:resolveLink', () => {
    it('rejects empty targetTitle', async () => {
      await expect(handlers['wiki:resolveLink']({}, 'graph-1', '')).rejects.toThrow(IpcError)
    })
  })
})
