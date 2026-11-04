import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const mockUserDataPath = path.join(os.tmpdir(), 'bizgraph-test-project-roots')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserDataPath
      return path.join(os.tmpdir(), name)
    }),
  },
}))

import { addTrustedProjectRoot, getTrustedProjectRoots } from '../services/project-roots'

describe('project-roots', () => {
  const originalHome = process.env.HOME

  beforeEach(async () => {
    await fs.rm(mockUserDataPath, { recursive: true, force: true })
    // validateProjectPath 拒绝 home 本身：指到临时目录，避免误伤
    process.env.HOME = path.join(os.tmpdir(), 'bizgraph-test-home')
  })

  afterEach(() => {
    process.env.HOME = originalHome
  })

  it('records a dialog-picked directory as a trusted root', async () => {
    const dir = path.join(os.tmpdir(), `bg-roots-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })

    expect(await addTrustedProjectRoot(dir)).toBe(true)
    expect(await getTrustedProjectRoots()).toContain(dir)
  })

  it('is idempotent on repeated registration', async () => {
    const dir = path.join(os.tmpdir(), `bg-roots-dup-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })

    await addTrustedProjectRoot(dir)
    await addTrustedProjectRoot(dir)
    const roots = await getTrustedProjectRoots()
    expect(roots.filter((r) => r === dir)).toHaveLength(1)
  })

  it('rejects blocked system directories', async () => {
    expect(await addTrustedProjectRoot('/etc')).toBe(false)
    expect(await addTrustedProjectRoot('/usr/local')).toBe(false)
    expect(await getTrustedProjectRoots()).toHaveLength(0)
  })

  it('rejects the home directory itself', async () => {
    expect(await addTrustedProjectRoot(process.env.HOME as string)).toBe(false)
    expect(await getTrustedProjectRoots()).toHaveLength(0)
  })

  it('returns [] for missing or corrupt roots file', async () => {
    await fs.mkdir(mockUserDataPath, { recursive: true })
    await fs.writeFile(path.join(mockUserDataPath, 'trusted-project-roots.json'), 'not json', 'utf-8')
    expect(await getTrustedProjectRoots()).toEqual([])
  })
})
