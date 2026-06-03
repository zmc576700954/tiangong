import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import type { Dirent } from 'node:fs'

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}))

import fs from 'node:fs/promises'
import { searchFilesRecursive } from '../ipc/fs'

const mockedReaddir = vi.mocked(fs.readdir)

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    parentPath: '/project',
    path: '/project',
  } as Dirent
}

describe('searchFilesRecursive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should find files matching query by name', async () => {
    // /project has src/ (dir) and README.md (file)
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('src', true),
      makeDirent('README.md', false),
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    // /project/src has App.tsx
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('App.tsx', false),
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', 'app', 20)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('App.tsx')
    expect(results[0].relativePath).toBe(path.join('src', 'App.tsx'))
    expect(results[0].path).toBe(path.join('/project', 'src', 'App.tsx'))
  })

  it('should skip node_modules and .git', async () => {
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('node_modules', true),
      makeDirent('.git', true),
      makeDirent('index.ts', false),
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', 'index', 20)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('index.ts')
    // node_modules and .git should not be read
    expect(mockedReaddir).toHaveBeenCalledTimes(1)
  })

  it('should respect limit', async () => {
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('a.ts', false),
      makeDirent('b.ts', false),
      makeDirent('c.ts', false),
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', '.ts', 2)
    expect(results).toHaveLength(2)
  })

  it('should return empty array for empty query', async () => {
    const results = await searchFilesRecursive('/project', '', 20)
    expect(results).toHaveLength(0)
  })

  it('should be case insensitive', async () => {
    mockedReaddir.mockResolvedValueOnce([
      makeDirent('README.md', false),
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    const results = await searchFilesRecursive('/project', 'readme', 20)
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('README.md')
  })
})
