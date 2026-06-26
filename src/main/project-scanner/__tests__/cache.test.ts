import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const mockUserDataPath = path.join(os.tmpdir(), 'bizgraph-test-cache')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserDataPath
      return path.join(os.tmpdir(), name)
    }),
  },
}))

// Import after mock
import { readProjectScanCache, writeProjectScanCache } from '../cache'
import type { ProjectScanResult } from '@shared/types'

async function createDummyProject(baseDir: string): Promise<string> {
  const projectDir = path.join(baseDir, 'project')
  await fs.mkdir(projectDir, { recursive: true })
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true })
  await fs.writeFile(path.join(projectDir, 'package.json'), '{"name":"test"}', 'utf-8')
  await fs.writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const a = 1', 'utf-8')
  return projectDir
}

function dummyResult(): ProjectScanResult {
  return {
    projectName: 'test',
    projectPath: '/tmp/test',
    framework: 'Node.js',
    packageJson: null,
    modules: [],
  }
}

describe('project-scanner cache', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-cache-test-'))
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
      await fs.rm(mockUserDataPath, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  it('write cache then read without changes → cache hit', async () => {
    const projectDir = await createDummyProject(tempDir)
    const result = dummyResult()

    await writeProjectScanCache(projectDir, result)
    const cached = await readProjectScanCache(projectDir)

    expect(cached).toEqual(result)
  })

  it('write cache then modify a file inside project → cache miss', async () => {
    const projectDir = await createDummyProject(tempDir)
    const result = dummyResult()

    await writeProjectScanCache(projectDir, result)

    // Modify a file inside the project
    await fs.writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const a = 2', 'utf-8')

    const cached = await readProjectScanCache(projectDir)
    expect(cached).toBeNull()
  })

  it('only change root directory mtime without file changes → cache hit', async () => {
    const projectDir = await createDummyProject(tempDir)
    const result = dummyResult()

    await writeProjectScanCache(projectDir, result)

    // Artificially update root directory mtime by touching it
    const now = new Date()
    await fs.utimes(projectDir, now, now)

    const cached = await readProjectScanCache(projectDir)
    expect(cached).toEqual(result)
  })
})
