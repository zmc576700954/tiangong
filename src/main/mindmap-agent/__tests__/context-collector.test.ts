import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Mock memory module
vi.mock('../memory', () => ({
  readMemory: vi.fn().mockResolvedValue({
    projectName: 'test',
    preferences: { namingStyle: 'technical', granularity: 'medium', maxModules: 6 },
    refinements: [],
    modules: [],
  }),
}))

import { collectContext } from '../context-collector'

describe('collectContext', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-collector-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns basic context with project info', async () => {
    const ctx = await collectContext(tmpDir, 'my-project', 'Node.js')

    expect(ctx.projectName).toBe('my-project')
    expect(ctx.projectPath).toBe(tmpDir)
    expect(ctx.framework).toBe('Node.js')
    expect(ctx.directoryTree).toBeDefined()
    expect(ctx.packageJsonSummary).toBeDefined()
    expect(ctx.readmeContent).toBeDefined()
    expect(ctx.entryPointContent).toBeDefined()
    expect(ctx.memory).toBeDefined()
    expect(ctx.keyFileSnippets).toBeDefined()
  })

  it('collects package.json summary', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test-app',
      description: 'A test app',
      version: '1.0.0',
      scripts: { dev: 'vite', build: 'tsc' },
      dependencies: { react: '^18.0.0', vue: '^3.0.0' },
    }))

    const ctx = await collectContext(tmpDir, 'test', 'React')

    expect(ctx.packageJsonSummary).toContain('name: test-app')
    expect(ctx.packageJsonSummary).toContain('description: A test app')
    expect(ctx.packageJsonSummary).toContain('version: 1.0.0')
    expect(ctx.packageJsonSummary).toContain('dev: vite')
    expect(ctx.packageJsonSummary).toContain('react')
  })

  it('handles missing package.json', async () => {
    const ctx = await collectContext(tmpDir, 'test', 'Node.js')
    expect(ctx.packageJsonSummary).toContain('无 package.json')
  })

  it('collects README content', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# My Project\n\nThis is a test.\n\n![image](test.png)')

    const ctx = await collectContext(tmpDir, 'test', 'Node.js')

    expect(ctx.readmeContent).toContain('My Project')
    expect(ctx.readmeContent).toContain('This is a test')
    // Image lines should be filtered out
    expect(ctx.readmeContent).not.toContain('![')
  })

  it('handles missing README', async () => {
    const ctx = await collectContext(tmpDir, 'test', 'Node.js')
    expect(ctx.readmeContent).toContain('无 README')
  })

  it('collects directory tree', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'))
    await fs.mkdir(path.join(tmpDir, 'src/components'))
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export {}')

    const ctx = await collectContext(tmpDir, 'test', 'Node.js')

    expect(ctx.directoryTree).toContain(path.basename(tmpDir))
    expect(ctx.directoryTree).toContain('src/')
  })

  it('excludes node_modules from directory tree', async () => {
    await fs.mkdir(path.join(tmpDir, 'node_modules'))
    await fs.mkdir(path.join(tmpDir, 'src'))
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export {}')

    const ctx = await collectContext(tmpDir, 'test', 'Node.js')

    expect(ctx.directoryTree).not.toContain('node_modules')
    expect(ctx.directoryTree).toContain('src/')
  })

  it('collects entry point content', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'console.log("hello")')

    const ctx = await collectContext(tmpDir, 'test', 'Node.js')

    expect(ctx.entryPointContent).toContain('console.log')
  })

  it('handles missing entry point', async () => {
    const ctx = await collectContext(tmpDir, 'test', 'Node.js')
    expect(ctx.entryPointContent).toContain('未找到入口文件')
  })

  it('collects key file snippets from src subdirectories', async () => {
    await fs.mkdir(path.join(tmpDir, 'src/auth'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'src/auth/index.ts'), '/**\n * Authentication module\n */\nexport function auth() {}')

    const ctx = await collectContext(tmpDir, 'test', 'Node.js')

    expect(ctx.keyFileSnippets).toContain('Authentication module')
  })

  it('handles missing src directory', async () => {
    const ctx = await collectContext(tmpDir, 'test', 'Node.js')
    expect(ctx.keyFileSnippets).toContain('无关键文件片段')
  })
})
