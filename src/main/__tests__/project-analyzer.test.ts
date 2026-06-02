import { describe, it, expect } from 'vitest'
import { ProjectAnalyzer } from '../project-analyzer'
import type { ProjectScanResult } from '@shared/types'

const sampleScanResult: ProjectScanResult = {
  projectName: 'TestProject',
  projectPath: '/tmp/test',
  framework: 'express',
  packageJson: {
    name: 'test-project',
    description: 'A test project',
    version: '1.0.0',
    scripts: { start: 'node index.js' },
    dependencies: ['express', 'lodash'],
    devDependencies: ['vitest'],
  },
  modules: [
    {
      name: 'Auth',
      description: 'Authentication module',
      processes: [
        {
          name: 'Login',
          description: 'User login flow',
          features: [
            { name: 'Validate credentials', description: 'Check password', type: 'feature' },
            { name: 'Generate token', description: 'JWT creation', type: 'feature' },
          ],
        },
        {
          name: 'Logout',
          description: 'User logout flow',
          features: [{ name: 'Clear session', description: 'Remove token', type: 'feature' }],
        },
      ],
    },
    {
      name: 'Orders',
      description: 'Order management',
      processes: [
        {
          name: 'Create Order',
          description: 'Place new order',
          features: [
            { name: 'Validate stock', description: 'Check inventory', type: 'feature' },
            { name: 'Calculate price', description: 'Apply discounts', type: 'feature' },
            { name: 'Save order', description: 'Persist to DB', type: 'feature' },
          ],
        },
      ],
    },
  ],
}

describe('ProjectAnalyzer', () => {
  it('should create a root node', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const root = result.nodes.find((n) => n.tempId === 'root')
    expect(root).toBeDefined()
    expect(root!.title).toBe('TestProject')
    expect(root!.type).toBe('module')
  })

  it('should create module nodes', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const modules = result.nodes.filter((n) => n.type === 'module' && n.tempId !== 'root')
    expect(modules.length).toBe(2)
    expect(modules[0].title).toBe('Auth')
    expect(modules[1].title).toBe('Orders')
  })

  it('should create process nodes with correct parent', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const processes = result.nodes.filter((n) => n.type === 'process')
    expect(processes.length).toBe(3) // Login, Logout, Create Order

    // Auth module has 2 processes
    const authProcesses = processes.filter((p) => p.parentTempId?.startsWith('module-0'))
    expect(authProcesses.length).toBe(2)
  })

  it('should create feature nodes', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const features = result.nodes.filter((n) => n.type === 'feature')
    expect(features.length).toBe(6) // 2 + 1 + 3
  })

  it('should create edges connecting hierarchy', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    // root -> module edges
    const rootEdges = result.edges.filter((e) => e.sourceTempId === 'root')
    expect(rootEdges.length).toBe(2)

    // module -> process edges
    const moduleEdges = result.edges.filter((e) =>
      result.nodes.some((n) => n.tempId === e.sourceTempId && n.type === 'module' && n.tempId !== 'root'),
    )
    expect(moduleEdges.length).toBe(3)

    // process -> feature edges
    const processEdges = result.edges.filter((e) =>
      result.nodes.some((n) => n.tempId === e.sourceTempId && n.type === 'process'),
    )
    expect(processEdges.length).toBe(6)
  })

  it('should apply correct owner roles', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const modules = result.nodes.filter((n) => n.type === 'module')
    const features = result.nodes.filter((n) => n.type === 'feature')

    expect(modules.every((n) => n.ownerRole === 'product')).toBe(true)
    expect(features.every((n) => n.ownerRole === 'developer')).toBe(true)
  })

  it('root node should include dependency metadata', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const root = result.nodes.find((n) => n.tempId === 'root')
    expect(root!.metadata).toBeDefined()
    expect(root!.metadata!.services).toBeDefined()
    expect(root!.metadata!.services!.length).toBeGreaterThan(0)
  })
})

describe('dagre layout', () => {
  it('should produce non-overlapping positions', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    // 简单碰撞检测：任意两个节点的中心点距离应大于最小间距
    const centers = result.nodes.map((n) => ({
      x: n.position.x + 80, // 粗估半宽
      y: n.position.y + 35,  // 粗估半高
    }))

    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const dx = Math.abs(centers[i].x - centers[j].x)
        const dy = Math.abs(centers[i].y - centers[j].y)
        // dagre 保证同层节点有 nodesep 间距，不同层有 ranksep 间距
        // 这里只验证不会完全重叠（dx 和 dy 不能同时很小）
        const overlaps = dx < 10 && dy < 10
        expect(overlaps).toBe(false)
      }
    }
  })

  it('should position root node to the left of modules', () => {
    const analyzer = new ProjectAnalyzer()
    const result = analyzer.analyze(sampleScanResult)

    const root = result.nodes.find((n) => n.tempId === 'root')
    const modules = result.nodes.filter((n) => n.type === 'module' && n.tempId !== 'root')

    expect(root).toBeDefined()
    for (const mod of modules) {
      expect(root!.position.x).toBeLessThan(mod.position.x)
    }
  })
})
