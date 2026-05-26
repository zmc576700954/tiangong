import { describe, it, expect } from 'vitest'
import { ProjectAnalyzer, computeOptimalLayout } from '../project-analyzer'
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

describe('computeOptimalLayout', () => {
  it('should adjust spacing based on module count', () => {
    const layout = computeOptimalLayout(sampleScanResult)
    expect(layout.moduleSpacingX).toBe(340) // 2 modules <= 3
    expect(layout.centerX).toBeGreaterThanOrEqual(400)
  })

  it('should position features on the right', () => {
    const layout = computeOptimalLayout(sampleScanResult)
    expect(layout.featureX).toBeGreaterThanOrEqual(1000)
  })
})
