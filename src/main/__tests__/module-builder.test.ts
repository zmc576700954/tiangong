import { describe, it, expect } from 'vitest'
import { buildModules } from '../project-scanner/module-builder'
import type { FileAnalysis, RouteInfo, EntityInfo } from '../project-scanner/types'

describe('buildModules', () => {
  const projectName = 'TestProject'
  const framework = 'react'
  const packageJson = {
    name: 'test',
    description: 'A test project',
    version: '1.0.0',
    dependencies: ['react', 'react-dom'],
    devDependencies: ['typescript'],
  }

  it('builds modules from src directories', () => {
    const structure = ['src/', 'src/user/', 'src/user/UserService.ts', 'src/product/', 'src/product/ProductList.tsx']
    const modules = buildModules(projectName, framework, packageJson, structure, [], [], [])
    expect(modules.length).toBeGreaterThan(0)
    expect(modules.some((m) => m.name.includes('用户') || m.name.toLowerCase().includes('user') || m.name.includes('产品') || m.name.toLowerCase().includes('product'))).toBe(true)
  })

  it('groups by routes when no src directories', () => {
    const structure: string[] = []
    const routes: RouteInfo[] = [
      { path: '/users', method: 'GET', handler: 'getUsers' },
      { path: '/orders', method: 'GET', handler: 'getOrders' },
    ]
    const modules = buildModules(projectName, framework, packageJson, structure, [], routes, [])
    expect(modules.length).toBeGreaterThan(0)
  })

  it('groups by entities when no src dirs or routes', () => {
    const structure: string[] = []
    const entities: EntityInfo[] = [
      { name: 'User', fields: ['id', 'name'], file: 'models/User.ts' },
    ]
    const modules = buildModules(projectName, framework, packageJson, structure, [], [], entities)
    expect(modules.length).toBeGreaterThan(0)
  })

  it('builds fallback module from scripts', () => {
    const structure: string[] = []
    const pkg = {
      ...packageJson,
      scripts: { dev: 'vite', build: 'tsc && vite build' },
    }
    const modules = buildModules(projectName, framework, pkg, structure, [], [], [])
    expect(modules.length).toBeGreaterThan(0)
    expect(modules[0].processes.some((p) => p.name.includes('开发运维'))).toBe(true)
  })

  it('extracts description from README file analysis', () => {
    const structure = ['src/', 'src/auth/']
    const fileAnalyses: FileAnalysis[] = [{
      filePath: 'README.md',
      content: 'This is a sample project for testing.\nIt does things.',
      language: 'markdown',
      purpose: 'other',
    }]
    const modules = buildModules(projectName, framework, packageJson, structure, fileAnalyses, [], [])
    expect(modules.length).toBeGreaterThan(0)
  })

  it('caps module count to 8', () => {
    const structure = [
      'src/',
      'src/a/', 'src/a/file.ts',
      'src/b/', 'src/b/file.ts',
      'src/c/', 'src/c/file.ts',
      'src/d/', 'src/d/file.ts',
      'src/e/', 'src/e/file.ts',
      'src/f/', 'src/f/file.ts',
      'src/g/', 'src/g/file.ts',
      'src/h/', 'src/h/file.ts',
      'src/i/', 'src/i/file.ts',
    ]
    const modules = buildModules(projectName, framework, packageJson, structure, [], [], [])
    expect(modules.length).toBeLessThanOrEqual(8)
  })
})
