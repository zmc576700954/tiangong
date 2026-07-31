import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { registerGraphHandlers } from '../graph'
import type { GraphService } from '../../services/graph-service'
import type { SnapshotRepository } from '../../repositories/snapshot-repository'
import { nodeTypeRegistry } from '../../shared/node-type-registry'
import type BetterSqlite3 from 'better-sqlite3'
import type { TypedHandle } from '../utils'
import type { AgentManager } from '../../agent/agent-manager'
import type { AgentRunner } from '../../wiki/llm-ingest-service'
import type { IngestResult, ComputeResult, LintReport, WritebackItem } from '@shared/types/wiki'
import type { Graph, GraphNode, GraphEdge } from '@shared/types'
import { NodeRepository } from '../../repositories/node-repository'
import type { EdgeRepository } from '../../repositories/edge-repository'
import { WritebackRepository } from '../../repositories/writeback-repository'
import { GraphRepository } from '../../repositories/graph-repository'
import { generateId } from '../../shared/env'

import { IpcError, ErrorCode } from '../../errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  } as unknown as BetterSqlite3.Database
  return { db, stmt: stmtMock }
}

function createFakeRepos() {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const nodeRepo = {
    findById: (id: string) => nodes.find((n) => n.id === id) ?? null,
    listByGraph: (graphId: string) => nodes.filter((n) => n.graphId === graphId),
    create(data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'>): GraphNode {
      const now = new Date().toISOString()
      const node: GraphNode = { ...data, id: generateId('node'), createdAt: now, updatedAt: now }
      nodes.push(node)
      return node
    },
    update(id: string, data: Partial<GraphNode>): GraphNode {
      const idx = nodes.findIndex((n) => n.id === id)
      if (idx === -1) throw new Error(`Node not found: ${id}`)
      nodes[idx] = { ...nodes[idx], ...data, updatedAt: new Date().toISOString() }
      return nodes[idx]
    },
    delete(id: string) {
      const idx = nodes.findIndex((n) => n.id === id)
      if (idx !== -1) nodes.splice(idx, 1)
    },
  }

  const edgeRepo = {
    create(data: Omit<GraphEdge, 'id'>): GraphEdge {
      const edge: GraphEdge = { ...data, id: generateId('edge') }
      edges.push(edge)
      return edge
    },
    delete(id: string) {
      const idx = edges.findIndex((e) => e.id === id)
      if (idx !== -1) edges.splice(idx, 1)
    },
    listByGraph: (graphId: string) => edges.filter((e) => e.graphId === graphId),
  }

  function addWikiPage(title: string, wikiContent: string, graphId = 'g1'): GraphNode {
    const now = new Date().toISOString()
    const data: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> = {
      type: 'wiki-page', status: 'draft', title, graphId, graphType: 'online',
      position: { x: 0, y: 0 }, wikiContent,
    }
    const node: GraphNode = { ...data, id: generateId('node'), createdAt: now, updatedAt: now }
    nodes.push(node)
    return node
  }

  return { nodeRepo, edgeRepo, nodes, edges, addWikiPage }
}

function createAgentManagerStub(): AgentManager {
  return {
    startSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentManager
}

function createGraphServiceStub(): GraphService {
  return {
    createGraph: vi.fn().mockResolvedValue({ id: 'graph-1' }),
    listGraphs: vi.fn().mockResolvedValue([]),
    getGraph: vi.fn().mockResolvedValue(null),
    deleteGraph: vi.fn().mockResolvedValue(undefined),
    deriveGraph: vi.fn().mockResolvedValue({ id: 'graph-2' }),
    initFromProject: vi.fn().mockResolvedValue({ onlineGraph: { id: 'g1' }, devGraph: { id: 'g2' }, modules: [] }),
    getProjectPaths: vi.fn().mockReturnValue([]),
  } as unknown as GraphService
}

function createSnapshotRepoStub(): SnapshotRepository {
  return {
    create: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
    listByGraph: vi.fn().mockResolvedValue([]),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as SnapshotRepository
}

function makeTypedHandle(handlers: Record<string, (...args: any[]) => Promise<unknown>>): TypedHandle {
  return (channel, handler) => {
    handlers[channel] = handler as (...args: any[]) => Promise<unknown>
  }
}

describe('registerGraphHandlers', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let graphService: GraphService
  let snapshotRepo: SnapshotRepository
  let db: BetterSqlite3.Database
  let stmtMock: ReturnType<typeof createMockDb>['stmt']
  let agentManager: AgentManager

  beforeEach(() => {
    handlers = {}
    graphService = createGraphServiceStub()
    snapshotRepo = createSnapshotRepoStub()
    const mock = createMockDb()
    db = mock.db
    stmtMock = mock.stmt
    agentManager = createAgentManagerStub()

    registerGraphHandlers(db, makeTypedHandle(handlers), graphService, snapshotRepo, agentManager)
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

  describe('wiki:parseContent', () => {
    it('rejects non-string content', async () => {
      await expect(handlers['wiki:parseContent']({}, 'graph-1', 123)).rejects.toThrow(IpcError)
    })

    it('rejects oversized content', async () => {
      await expect(handlers['wiki:parseContent']({}, 'graph-1', 'x'.repeat(512 * 1024 + 1))).rejects.toThrow(IpcError)
    })

    it('returns parsed structure for valid input', async () => {
      const result = await handlers['wiki:parseContent']({}, 'graph-1', '# T\n\n[[Missing]]') as { links: unknown[]; frontmatter: Record<string, unknown> }
      expect(result.links).toHaveLength(1)
      expect(result.frontmatter).toEqual({})
    })
  })

  describe('wiki:getBacklinks', () => {
    it('rejects empty nodeId', async () => {
      await expect(handlers['wiki:getBacklinks']({}, '')).rejects.toThrow(IpcError)
    })
  })

  describe('wiki:findDangling', () => {
    it('rejects empty graphId', async () => {
      await expect(handlers['wiki:findDangling']({}, '')).rejects.toThrow(IpcError)
    })
  })

  describe('wiki:ingestFiles', () => {
    it('rejects empty filePaths', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', [])).rejects.toThrow(IpcError)
    })

    it('rejects non-array filePaths', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', 'x.md')).rejects.toThrow(IpcError)
    })

    it('rejects oversized batch', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', Array(101).fill('/a.md'))).rejects.toThrow(IpcError)
    })

    it('rejects unknown graph', async () => {
      await expect(handlers['wiki:ingestFiles']({}, 'missing-graph', ['/tmp/a.md'])).rejects.toThrow(IpcError)
    })

    it('rejects system paths', async () => {
      (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [],
      })
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', ['/etc/passwd.md'])).rejects.toThrow(IpcError)
    })

    it('rejects invalid mode', async () => {
      (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [],
      })
      await expect(handlers['wiki:ingestFiles']({}, 'graph-1', ['/tmp/a.md'], 'bad')).rejects.toThrow(IpcError)
    })

    it('ingests files with default rule mode', async () => {
      (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [],
      })
      const filePath = path.join(os.tmpdir(), `ingest-test-页面-${process.pid}.md`)
      await fs.writeFile(filePath, '# ingest-test-页面\n\n内容', 'utf-8')
      try {
        const result = await handlers['wiki:ingestFiles']({}, 'graph-1', [filePath]) as IngestResult
        expect(result.failed).toEqual([])
        expect(result.created).toHaveLength(1)
        expect(result.created[0].title).toBe('ingest-test-页面')
      } finally {
        await fs.unlink(filePath).catch(() => undefined)
      }
    })

    it('explicit mode rule uses rule path', async () => {
      (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [],
      })
      const filePath = path.join(os.tmpdir(), `ingest-rule-${process.pid}.md`)
      await fs.writeFile(filePath, '# Rule模式\n\n内容', 'utf-8')
      try {
        const result = await handlers['wiki:ingestFiles']({}, 'graph-1', [filePath], 'rule') as IngestResult
        expect(result.failed).toEqual([])
        expect(result.created).toHaveLength(1)
        expect(result.created[0].title).toBe('Rule模式')
      } finally {
        await fs.unlink(filePath).catch(() => undefined)
      }
    })

    describe('llm mode', () => {
      let agentRunner: AgentRunner
      beforeEach(() => {
        agentRunner = vi.fn().mockResolvedValue('---\ntitle: LLM提炼\n---\n\n# LLM提炼\n\n内容。')
        handlers = {}
        registerGraphHandlers(
          db,
          makeTypedHandle(handlers),
          graphService,
          snapshotRepo,
          agentManager,
          { agentRunner },
        )
      })

      it('rejects llm mode without projectPath', async () => {
        (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
          graph: { id: 'graph-1', type: 'online' }, nodes: [], edges: [], bugs: [],
        })
        await expect(handlers['wiki:ingestFiles']({}, 'graph-1', ['/tmp/a.md'], 'llm')).rejects.toMatchObject({
          code: ErrorCode.IPC_INVALID_ARGUMENT,
          message: expect.stringContaining('projectPath'),
        })
      })

      describe('agent unavailable', () => {
        beforeEach(() => {
          agentRunner = vi.fn().mockRejectedValue(new Error('adapter not found'))
          handlers = {}
          registerGraphHandlers(
            db,
            makeTypedHandle(handlers),
            graphService,
            snapshotRepo,
            agentManager,
            { agentRunner },
          )
        })

        it('rejects whole call when agentRunner fails on the first file', async () => {
          (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValue({
            graph: { id: 'graph-1', type: 'online', projectPath: '/tmp/project' }, nodes: [], edges: [], bugs: [],
          })
          const filePath = path.join(os.tmpdir(), `ingest-llm-fail-${process.pid}.md`)
          await fs.writeFile(filePath, 'raw content', 'utf-8')
          try {
            await expect(handlers['wiki:ingestFiles']({}, 'graph-1', [filePath], 'llm')).rejects.toMatchObject({
              code: ErrorCode.AGENT_ADAPTER_ERROR,
              message: expect.stringContaining('LLM 不可用'),
            })
          } finally {
            await fs.unlink(filePath).catch(() => undefined)
          }
        })
      })

      it('routes through injected agentRunner override', async () => {
        (graphService.getGraph as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          graph: { id: 'graph-1', type: 'online', projectPath: '/tmp/project' }, nodes: [], edges: [], bugs: [],
        })
        const filePath = path.join(os.tmpdir(), `ingest-llm-${process.pid}.md`)
        await fs.writeFile(filePath, 'raw content', 'utf-8')
        try {
          const result = await handlers['wiki:ingestFiles']({}, 'graph-1', [filePath], 'llm') as IngestResult
          expect(result.failed).toEqual([])
          expect(result.created).toHaveLength(1)
          expect(result.created[0].title).toBe('LLM提炼')
          expect(agentRunner).toHaveBeenCalled()
        } finally {
          await fs.unlink(filePath).catch(() => undefined)
        }
      })
    })
  })
})

describe('registerGraphHandlers wiki integration', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let f: ReturnType<typeof createFakeRepos>
  let graphService: GraphService
  let snapshotRepo: SnapshotRepository
  let db: BetterSqlite3.Database
  let agentManager: AgentManager

  beforeEach(() => {
    handlers = {}
    f = createFakeRepos()
    graphService = createGraphServiceStub()
    snapshotRepo = createSnapshotRepoStub()
    db = createMockDb().db
    agentManager = createAgentManagerStub()

    const graphRepo = {
      create: (data: { name: string; type: Graph['type'] }) => {
        const graph: Graph = { id: 'g1', ...data, createdAt: '', updatedAt: '' }
        return graph
      },
      get: (id: string) => {
        if (id !== 'g1') return null
        return { graph: { id: 'g1', name: 'G', type: 'online', createdAt: '', updatedAt: '' }, nodes: [], edges: [], bugs: [] }
      },
    } as unknown as GraphService['graphRepo']
    ;(graphService as unknown as { graphRepo: typeof graphRepo }).graphRepo = graphRepo

    const nodeProxy = new Proxy(f.nodeRepo, {
      get(target, prop) {
        return (target as Record<string, unknown>)[prop as string]
      },
    }) as unknown as NodeRepository
    const edgeProxy = new Proxy(f.edgeRepo, {
      get(target, prop) {
        return (target as Record<string, unknown>)[prop as string]
      },
    }) as unknown as EdgeRepository

    registerGraphHandlers(
      db,
      makeTypedHandle(handlers),
      graphService,
      snapshotRepo,
      agentManager,
      { nodeRepo: nodeProxy, edgeRepo: edgeProxy },
    )
  })

  describe('wiki:computeCommunities', () => {
    it('rejects empty graphId', async () => {
      await expect(handlers['wiki:computeCommunities']({}, '')).rejects.toThrow(IpcError)
    })

    it('returns ComputeResult on a graph with wiki-link edges', async () => {
      const a = f.addWikiPage('页面A', '# A')
      const b = f.addWikiPage('页面B', '# B\n\n[[页面A]]')
      const c = f.addWikiPage('页面C', '# C\n\n[[页面A]]')
      f.edgeRepo.create({ source: b.id, target: a.id, edgeType: 'wiki-link', graphId: 'g1' })
      f.edgeRepo.create({ source: c.id, target: a.id, edgeType: 'wiki-link', graphId: 'g1' })

      const result = await handlers['wiki:computeCommunities']({}, 'g1') as ComputeResult
      expect(result.nodeCount).toBe(3)
      expect(result.communityCount).toBeGreaterThanOrEqual(1)
      expect(result.communities.length).toBe(result.communityCount)
    })
  })

  describe('wiki:lint', () => {
    it('returns LintReport with a dangling link issue', async () => {
      f.addWikiPage('页面A', '# A')
      f.addWikiPage('页面B', '# B\n\n参见 [[不存在的页面]]。')

      const result = await handlers['wiki:lint']({}, 'g1') as LintReport
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'dangling-link' }),
        ]),
      )
      expect(result.stats.nodeCount).toBe(2)
    })
  })
})

// ---------- Writeback IPC：真实内存库（不写 FK pragma，模拟生产连接） ----------
function makeWritebackDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE graphs (id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('online', 'dev')), project_path TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('project', 'module', 'process', 'feature', 'bug', 'wiki-page')),
      status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder')),
      title TEXT NOT NULL,
      description TEXT,
      acceptance_criteria TEXT,
      graph_id TEXT NOT NULL,
      graph_type TEXT NOT NULL CHECK(graph_type IN ('online', 'dev')),
      parent_id TEXT,
      rules TEXT,
      metadata TEXT,
      owner_role TEXT CHECK(owner_role IN ('product', 'developer', 'tester')),
      position_x REAL NOT NULL,
      position_y REAL NOT NULL,
      content TEXT,
      community_summary TEXT,
      community_level INTEGER,
      community_id TEXT,
      context_refs TEXT,
      wiki_content TEXT,
      wiki_meta TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE edges (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      label TEXT,
      edge_type TEXT CHECK(edge_type IN ('default', 'success', 'failure', 'condition', 'business-flow', 'semantic', 'dependency', 'co-change', 'wiki-link')),
      graph_id TEXT NOT NULL,
      content TEXT,
      description TEXT,
      data_flow TEXT,
      strength REAL
    );
    CREATE TABLE bug_nodes (id TEXT PRIMARY KEY, graph_id TEXT, node_id TEXT);
    CREATE TABLE snapshots (id TEXT PRIMARY KEY, graph_id TEXT);
    CREATE TABLE agent_logs (id TEXT PRIMARY KEY, graph_id TEXT);
    CREATE TABLE writeback_items (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('append-log','new-page')),
      target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      title TEXT NOT NULL, content TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','discarded')),
      created_at TEXT NOT NULL, resolved_at TEXT
    );
  `)
  return db
}

describe('registerGraphHandlers writeback（真实内存库）', () => {
  let handlers: Record<string, (...args: any[]) => Promise<unknown>>
  let db: Database.Database
  let nodeRepo: NodeRepository
  let writebackRepo: WritebackRepository

  beforeEach(() => {
    handlers = {}
    db = makeWritebackDb()
    db.prepare(`INSERT INTO graphs (id,name,type,created_at,updated_at) VALUES ('g1','G1','online','2026-01-01','2026-01-01')`).run()
    db.prepare(`INSERT INTO graphs (id,name,type,created_at,updated_at) VALUES ('g2','G2','online','2026-01-01','2026-01-01')`).run()
    nodeRepo = new NodeRepository(db)
    writebackRepo = new WritebackRepository(db)

    registerGraphHandlers(
      db,
      makeTypedHandle(handlers),
      createGraphServiceStub(),
      createSnapshotRepoStub(),
      createAgentManagerStub(),
    )
  })

  function seedItem(overrides?: Partial<Parameters<WritebackRepository['create']>[0]>): WritebackItem {
    return writebackRepo.create({
      graphId: 'g1',
      kind: 'append-log',
      targetNodeId: overrides?.targetNodeId ?? 'n1',
      title: '会话日志 · 2026-07-31',
      content: '\n## 会话日志 · 2026-07-31\n\n- 发现 X\n',
      sourceSessionId: `sess_${generateId('t')}`,
      confidence: 0.8,
      ...overrides,
    })
  }

  it('wiki:listWriteback returns only pending items of the requested graph', async () => {
    nodeRepo.create({ type: 'wiki-page', status: 'confirmed', title: '页面A', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } })
    nodeRepo.create({ type: 'wiki-page', status: 'confirmed', title: '页面B', graphId: 'g2', graphType: 'online', position: { x: 0, y: 0 } })
    const n1 = nodeRepo.listByGraph('g1')[0]
    const n2 = nodeRepo.listByGraph('g2')[0]

    const pending1 = seedItem({ targetNodeId: n1.id })
    const accepted = seedItem({ targetNodeId: n1.id })
    writebackRepo.updateStatus(accepted.id, 'accepted')
    seedItem({ targetNodeId: n2.id, graphId: 'g2' }) // 别的图的 pending

    const items = await handlers['wiki:listWriteback']({}, 'g1') as WritebackItem[]
    expect(items.map((i) => i.id)).toEqual([pending1.id])
  })

  it('wiki:listWriteback rejects empty graphId', async () => {
    await expect(handlers['wiki:listWriteback']({}, '')).rejects.toThrow(IpcError)
  })

  it('wiki:countWriteback returns pending count for graph', async () => {
    const node = nodeRepo.create({ type: 'wiki-page', status: 'confirmed', title: '页面A', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } })
    seedItem({ targetNodeId: node.id })
    const accepted = seedItem({ targetNodeId: node.id })
    writebackRepo.updateStatus(accepted.id, 'accepted')

    await expect(handlers['wiki:countWriteback']({}, 'g1')).resolves.toBe(1)
    await expect(handlers['wiki:countWriteback']({}, '')).rejects.toThrow(IpcError)
  })

  it('wiki:acceptWriteback rejects empty itemId', async () => {
    await expect(handlers['wiki:acceptWriteback']({}, '')).rejects.toThrow(IpcError)
  })

  it('wiki:acceptWriteback appends section to node wikiContent and marks accepted', async () => {
    const node = nodeRepo.create({
      type: 'wiki-page', status: 'confirmed', title: '页面A',
      graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 },
      wikiContent: '# 页面A\n\n原有内容。\n',
    })
    const item = seedItem({ targetNodeId: node.id })

    await handlers['wiki:acceptWriteback']({}, item.id)

    const updated = nodeRepo.findById(node.id)!
    expect(updated.wikiContent).toContain('原有内容。')
    expect(updated.wikiContent).toContain('## 会话日志 · 2026-07-31')
    expect(updated.wikiContent).toContain('- 发现 X')
    expect(writebackRepo.findById(item.id)!.status).toBe('accepted')
  })

  it('wiki:discardWriteback marks item discarded; unknown id is a silent no-op', async () => {
    const node = nodeRepo.create({ type: 'wiki-page', status: 'confirmed', title: '页面A', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } })
    const item = seedItem({ targetNodeId: node.id })

    await handlers['wiki:discardWriteback']({}, item.id)
    expect(writebackRepo.findById(item.id)!.status).toBe('discarded')
    expect(writebackRepo.findById(item.id)!.resolvedAt).not.toBeNull()

    // 未知 id：静默 no-op，不抛错
    await expect(handlers['wiki:discardWriteback']({}, 'writeback-nonexistent')).resolves.toBeUndefined()
    await expect(handlers['wiki:discardWriteback']({}, '')).rejects.toThrow(IpcError)
  })

  it('GraphRepository.delete removes writeback_items explicitly（不依赖 FK CASCADE）', () => {
    const node = nodeRepo.create({ type: 'wiki-page', status: 'confirmed', title: '页面A', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 } })
    seedItem({ targetNodeId: node.id })
    expect(writebackRepo.countPending('g1')).toBe(1)

    new GraphRepository(db).delete('g1')

    const count = (db.prepare('SELECT COUNT(*) AS c FROM writeback_items').get() as { c: number }).c
    expect(count).toBe(0)
  })
})
