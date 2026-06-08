import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGraphStore } from '../graphStore'

// Mock window.electronAPI
vi.stubGlobal('window', {
  electronAPI: {
    'graph:list': vi.fn().mockResolvedValue([]),
    'graph:get': vi.fn().mockResolvedValue(null),
    'graph:create': vi.fn().mockImplementation((data: { name: string; type: string }) => ({
      id: 'graph-server-id',
      name: data.name,
      type: data.type,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    })),
    'graph:derive': vi.fn().mockImplementation((sourceId: string, name?: string) => ({
      id: 'graph-derived-id',
      name: name ?? 'Derived',
      type: 'dev',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    })),
    'graph:delete': vi.fn().mockResolvedValue(true),
    'node:create': vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      ...data,
      id: 'node-server-id',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    })),
    'node:update': vi.fn().mockImplementation((id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
      updatedAt: '2024-01-01',
    })),
    'node:delete': vi.fn().mockResolvedValue(true),
    'node:batchUpdatePositions': vi.fn().mockResolvedValue(true),
    'edge:create': vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      ...data,
      id: 'edge-server-id',
    })),
    'edge:update': vi.fn().mockImplementation((id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
    })),
    'edge:delete': vi.fn().mockResolvedValue(true),
    'bug:create': vi.fn().mockImplementation((data: Record<string, unknown>) => ({
      ...data,
      id: 'bug-server-id',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    })),
    'bug:update': vi.fn().mockImplementation((id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
      updatedAt: '2024-01-01',
    })),
    'bug:delete': vi.fn().mockResolvedValue(true),
  },
})

describe('graphStore', () => {
  beforeEach(() => {
    useGraphStore.setState({
      graphs: [],
      currentGraphId: null,
      nodes: [],
      edges: [],
      bugs: [],
      selectedNodeId: null,
      selectedEdgeId: null,
    })
    vi.clearAllMocks()
  })

  // ==========================================
  // Graph Operations
  // ==========================================
  describe('Graph Operations', () => {
    it('loadGraphs fetches and sets graphs', async () => {
      const mockGraphs = [
        { id: 'g1', name: 'Test', type: 'online', createdAt: '', updatedAt: '' },
      ]
      vi.mocked(window.electronAPI['graph:list']).mockResolvedValueOnce(mockGraphs)
      await useGraphStore.getState().loadGraphs()
      expect(useGraphStore.getState().graphs).toEqual(mockGraphs)
    })

    it('createGraph adds graph to state', async () => {
      const graph = await useGraphStore.getState().createGraph('Test Graph', 'online')
      expect(graph.id).toBe('graph-server-id')
      expect(useGraphStore.getState().graphs).toHaveLength(1)
    })

    it('createGraph with sourceGraphId calls derive', async () => {
      const graph = await useGraphStore.getState().createGraph('Dev Copy', 'dev', 'g-source')
      expect(window.electronAPI['graph:derive']).toHaveBeenCalledWith('g-source', 'Dev Copy')
      expect(graph.id).toBe('graph-derived-id')
    })

    it('deleteGraph removes graph and clears currentGraphId if matching', async () => {
      await useGraphStore.getState().createGraph('To Delete', 'online')
      useGraphStore.setState({ currentGraphId: 'graph-server-id' })
      await useGraphStore.getState().deleteGraph('graph-server-id')
      expect(useGraphStore.getState().graphs).toHaveLength(0)
      expect(useGraphStore.getState().currentGraphId).toBeNull()
    })

    it('setCurrentGraph sets id and clears selections', () => {
      useGraphStore.setState({
        graphs: [{ id: 'g1', name: 'G1', type: 'online', createdAt: '', updatedAt: '' }],
        selectedNodeId: 'n1',
        selectedEdgeId: 'e1',
      })
      useGraphStore.getState().setCurrentGraph('g1')
      const state = useGraphStore.getState()
      expect(state.currentGraphId).toBe('g1')
      expect(state.selectedNodeId).toBeNull()
      expect(state.selectedEdgeId).toBeNull()
    })

    it('setCurrentGraph null clears nodes/edges/bugs', () => {
      useGraphStore.setState({ nodes: [{ id: 'n1' } as never], edges: [{ id: 'e1' } as never], bugs: [{ id: 'b1' } as never] })
      useGraphStore.getState().setCurrentGraph(null)
      const state = useGraphStore.getState()
      expect(state.currentGraphId).toBeNull()
      expect(state.nodes).toHaveLength(0)
      expect(state.edges).toHaveLength(0)
      expect(state.bugs).toHaveLength(0)
    })
  })

  // ==========================================
  // Node Operations (optimistic updates)
  // ==========================================
  describe('Node Operations', () => {
    it('createNode adds optimistically then replaces with server response', async () => {
      useGraphStore.setState({ nodes: [] })
      const node = await useGraphStore.getState().createNode({
        type: 'feature',
        status: 'draft',
        title: 'Login',
        graphId: 'g1',
        graphType: 'online',
        position: { x: 0, y: 0 },
      } as never)
      expect(node.id).toBe('node-server-id')
      expect(useGraphStore.getState().nodes).toHaveLength(1)
    })

    it('createNode rolls back on failure', async () => {
      vi.mocked(window.electronAPI['node:create']).mockRejectedValueOnce(new Error('DB error'))
      try {
        await useGraphStore.getState().createNode({
          type: 'feature',
          status: 'draft',
          title: 'Fail',
          graphId: 'g1',
          graphType: 'online',
          position: { x: 0, y: 0 },
        } as never)
      } catch {
        // Expected
      }
      expect(useGraphStore.getState().nodes).toHaveLength(0)
    })

    it('updateNode applies optimistic update then confirms', async () => {
      useGraphStore.setState({
        nodes: [{ id: 'n1', title: 'Old', type: 'feature', status: 'draft', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, createdAt: '', updatedAt: '' }],
      })
      await useGraphStore.getState().updateNode('n1', { title: 'New' } as never)
      // Server returns the updated node (with id 'n1')
      expect(useGraphStore.getState().nodes[0].title).toBe('New')
    })

    it('updateNode rolls back on failure', async () => {
      useGraphStore.setState({
        nodes: [{ id: 'n1', title: 'Original', type: 'feature', status: 'draft', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, createdAt: '', updatedAt: '' }],
      })
      vi.mocked(window.electronAPI['node:update']).mockRejectedValueOnce(new Error('DB error'))
      try {
        await useGraphStore.getState().updateNode('n1', { title: 'Failed' } as never)
      } catch {
        // Expected
      }
      expect(useGraphStore.getState().nodes[0].title).toBe('Original')
    })

    it('deleteNode removes node and associated edges', async () => {
      useGraphStore.setState({
        nodes: [{ id: 'n1', title: 'N1', type: 'feature', status: 'draft', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, createdAt: '', updatedAt: '' }],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', graphId: 'g1' }],
      })
      await useGraphStore.getState().deleteNode('n1')
      expect(useGraphStore.getState().nodes).toHaveLength(0)
      expect(useGraphStore.getState().edges).toHaveLength(0)
    })

    it('selectNode sets selectedNodeId and clears selectedEdgeId', () => {
      useGraphStore.setState({ selectedEdgeId: 'e1' })
      useGraphStore.getState().selectNode('n1')
      expect(useGraphStore.getState().selectedNodeId).toBe('n1')
      expect(useGraphStore.getState().selectedEdgeId).toBeNull()
    })

    it('batchUpdatePositions updates positions optimistically', async () => {
      useGraphStore.setState({
        nodes: [
          { id: 'n1', title: 'N1', type: 'feature', status: 'draft', graphId: 'g1', graphType: 'online', position: { x: 0, y: 0 }, createdAt: '', updatedAt: '' },
          { id: 'n2', title: 'N2', type: 'feature', status: 'draft', graphId: 'g1', graphType: 'online', position: { x: 100, y: 100 }, createdAt: '', updatedAt: '' },
        ],
      })
      await useGraphStore.getState().batchUpdatePositions([
        { id: 'n1', x: 50, y: 50 },
        { id: 'n2', x: 200, y: 200 },
      ])
      expect(useGraphStore.getState().nodes[0].position).toEqual({ x: 50, y: 50 })
      expect(useGraphStore.getState().nodes[1].position).toEqual({ x: 200, y: 200 })
    })
  })

  // ==========================================
  // Edge Operations
  // ==========================================
  describe('Edge Operations', () => {
    it('createEdge adds optimistically', async () => {
      const edge = await useGraphStore.getState().createEdge({
        source: 'n1',
        target: 'n2',
        graphId: 'g1',
      } as never)
      expect(edge.id).toBe('edge-server-id')
      expect(useGraphStore.getState().edges).toHaveLength(1)
    })

    it('deleteEdge rolls back on failure', async () => {
      useGraphStore.setState({
        edges: [{ id: 'e1', source: 'n1', target: 'n2', graphId: 'g1' }],
      })
      vi.mocked(window.electronAPI['edge:delete']).mockRejectedValueOnce(new Error('fail'))
      try {
        await useGraphStore.getState().deleteEdge('e1')
      } catch {
        // Expected
      }
      expect(useGraphStore.getState().edges).toHaveLength(1)
    })

    it('selectEdge sets selectedEdgeId and clears selectedNodeId', () => {
      useGraphStore.setState({ selectedNodeId: 'n1' })
      useGraphStore.getState().selectEdge('e1')
      expect(useGraphStore.getState().selectedEdgeId).toBe('e1')
      expect(useGraphStore.getState().selectedNodeId).toBeNull()
    })
  })

  // ==========================================
  // Bug Operations
  // ==========================================
  describe('Bug Operations', () => {
    it('createBug adds optimistically', async () => {
      const bug = await useGraphStore.getState().createBug({
        title: 'Login Crash',
        description: 'Crashes on login',
        severity: 'high',
        status: 'open',
        nodeId: 'n1',
        graphId: 'g1',
      } as never)
      expect(bug.id).toBe('bug-server-id')
      expect(useGraphStore.getState().bugs).toHaveLength(1)
    })

    it('deleteBug removes optimistically and rolls back on failure', async () => {
      useGraphStore.setState({
        bugs: [{ id: 'b1', title: 'Bug1', description: 'desc', severity: 'low', status: 'open', nodeId: 'n1', graphId: 'g1', createdAt: '', updatedAt: '' }],
      })
      vi.mocked(window.electronAPI['bug:delete']).mockRejectedValueOnce(new Error('fail'))
      try {
        await useGraphStore.getState().deleteBug('b1')
      } catch {
        // Expected
      }
      // Rollback: bug should still be present
      expect(useGraphStore.getState().bugs).toHaveLength(1)
    })
  })
})
