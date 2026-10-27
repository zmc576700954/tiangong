import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

const TEST_USER_DATA = path.join(os.tmpdir(), 'bizgraph-graph-svc-sort-' + process.pid)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? TEST_USER_DATA : os.tmpdir()),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}))

const mockScanResult = {
  projectName: 'Test Project',
  projectPath: '/project',
  framework: 'react',
  packageJson: null,
  modules: [
    {
      name: 'M1',
      description: 'module one',
      processes: [{ name: 'P1', description: 'process one', features: [] }],
    },
  ],
}

// 一个父节点 P1 + 三个兄弟 C1/C2/C3（数组顺序 = analyzer 的输出顺序）
const mockGraphResult = {
  projectName: 'Test Project',
  projectPath: '/project',
  framework: 'react',
  nodes: [
    { tempId: 'root', type: 'project', status: 'confirmed', title: 'Root', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], ownerRole: 'product' },
    { tempId: 'p1', type: 'module', status: 'draft', title: 'P1', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'root', ownerRole: 'product' },
    { tempId: 'c1', type: 'process', status: 'draft', title: 'C1', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'p1', ownerRole: 'product' },
    { tempId: 'c2', type: 'process', status: 'draft', title: 'C2', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'p1', ownerRole: 'product' },
    { tempId: 'c3', type: 'process', status: 'draft', title: 'C3', description: '', graphId: '', graphType: 'online', position: { x: 0, y: 0 }, metadata: {}, acceptanceCriteria: [], parentTempId: 'p1', ownerRole: 'product' },
  ],
  // 类型不能省：`edges: []` 会被推成 never[]，后续用例往里塞边就编译不过
  edges: [] as Array<{
    sourceTempId: string
    targetTempId: string
    edgeType?: string
    graphId: string
  }>,
}

vi.mock('../../project-scanner', () => ({
  ProjectScanner: vi.fn().mockImplementation(function () {
    return { scan: vi.fn().mockResolvedValue(mockScanResult) }
  }),
}))

vi.mock('../../project-analyzer', () => ({
  ProjectAnalyzer: vi.fn().mockImplementation(function () {
    return { analyze: vi.fn().mockReturnValue(mockGraphResult) }
  }),
}))

import { initDatabase, closeDatabase, getClient } from '../../database'
import { GraphService } from '../graph-service'

describe('GraphService.createNodes — 兄弟顺序与层级边补建', () => {
  let db: ReturnType<typeof getClient>

  beforeAll(() => {
    initDatabase()
    db = getClient()
  })

  afterAll(() => {
    closeDatabase()
  })

  it('assigns consecutive sort_index to siblings written by the scan path', async () => {
    mockGraphResult.edges = []

    const service = new GraphService(db)
    const { onlineGraph } = await service.initFromProject({
      projectPath: '/project',
      projectName: 'Test Project',
    })

    const parent = db
      .prepare("SELECT id FROM nodes WHERE graph_id = ? AND title = 'P1'")
      .get(onlineGraph.id) as { id: string }
    const rows = db
      .prepare('SELECT id, title, sort_index FROM nodes WHERE parent_id = ? ORDER BY sort_index')
      .all(parent.id) as { id: string; title: string; sort_index: number }[]

    expect(rows.map((r) => r.title)).toEqual(['C1', 'C2', 'C3'])
    expect(rows.map((r) => r.sort_index)).toEqual([0, 1, 2])

    // 第四轮补建：每个有 parent_id 的节点都必须有**且只有一条** hierarchical 边
    // （这一段是本任务的主要交付物 —— 没有它，第四轮整个删掉测试照样绿）
    for (const child of rows) {
      const edges = db
        .prepare('SELECT edge_type FROM edges WHERE source = ? AND target = ?')
        .all(parent.id, child.id) as { edge_type: string }[]
      expect(edges).toHaveLength(1)
      expect(edges[0].edge_type).toBe('hierarchical')
    }
  })

  it('同一对上把已有的 default 边升级成 hierarchical，而不是再插一条', async () => {
    // AI 写入路径产出的层级边**就是 'default'**（graph-service.ts:508）
    mockGraphResult.edges = [
      { sourceTempId: 'p1', targetTempId: 'c1', edgeType: 'default', graphId: '' },
    ]

    const service = new GraphService(db)
    const { onlineGraph } = await service.initFromProject({
      projectPath: '/project',
      projectName: 'Test Project',
    })

    const parent = db
      .prepare("SELECT id FROM nodes WHERE graph_id = ? AND title = 'P1'")
      .get(onlineGraph.id) as { id: string }
    const child = db
      .prepare("SELECT id FROM nodes WHERE graph_id = ? AND title = 'C1'")
      .get(onlineGraph.id) as { id: string }

    const edges = db
      .prepare('SELECT edge_type FROM edges WHERE source = ? AND target = ?')
      .all(parent.id, child.id) as { edge_type: string }[]

    // 升级（而不是再插一条）：同一对上仍然**只有一条**边，且类型变成 hierarchical
    // 少了「升级」这一级，这一对会变成两条边（一条 default + 一条 hierarchical）
    expect(edges).toHaveLength(1)
    expect(edges[0].edge_type).toBe('hierarchical')
  })
})
