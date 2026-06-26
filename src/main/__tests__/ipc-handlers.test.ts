import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { cachedRealpath } from '../ipc-handlers'
import { setPlatformProviderForTest } from '../platform/platform-provider'
import type { PlatformProvider } from '../platform/platform-provider'

function createMockProvider(overrides: Partial<PlatformProvider> = {}): PlatformProvider {
  return {
    platform: process.platform,
    arch: process.arch,
    isMac: process.platform === 'darwin',
    isWindows: process.platform === 'win32',
    isLinux: process.platform === 'linux',
    isArm64: process.arch === 'arm64',
    isWsl: false,
    normalizePath: (p: string) => p,
    pathsEqual: (a: string, b: string) => a === b,
    isSystemPath: () => false,
    isWithinParent: (_child: string, _parent: string) => false,
    killProcess: vi.fn(),
    getShellConfig: vi.fn().mockReturnValue({ shell: true }),
    whichCommand: vi.fn().mockReturnValue(null),
    getWatcherOptions: vi.fn().mockReturnValue({}),
    ...overrides,
  } as PlatformProvider
}

describe('cachedRealpath', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cachedRealpath-'))
    setPlatformProviderForTest(createMockProvider())
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    setPlatformProviderForTest(null)
  })

  afterEach(async () => {
    // Clean up any symlinks created during tests
    const entries = await fs.readdir(tmpDir)
    for (const entry of entries) {
      const fullPath = path.join(tmpDir, entry)
      try {
        const stat = await fs.lstat(fullPath)
        if (stat.isSymbolicLink()) {
          await fs.unlink(fullPath)
        }
      } catch {
        // ignore
      }
    }
  })

  it('resolves an existing file path', async () => {
    const filePath = path.join(tmpDir, 'existing.txt')
    await fs.writeFile(filePath, 'hello')

    const result = await cachedRealpath(filePath)
    expect(result).toBe(path.resolve(filePath))
  })

  it('does not cache fallback for non-existent paths (TOCTOU protection)', async () => {
    const nonExistentPath = path.join(tmpDir, 'nonexistent.txt')
    const outsideDir = path.join(tmpDir, 'outside')
    await fs.mkdir(outsideDir, { recursive: true })
    const symlinkTarget = path.join(outsideDir, 'target.txt')
    await fs.writeFile(symlinkTarget, 'target')

    // 1. First call: path does not exist, should fall back and NOT cache
    const firstResult = await cachedRealpath(nonExistentPath)
    expect(firstResult).toBe(path.resolve(nonExistentPath))

    // 2. Create a symlink at the previously non-existent path
    try {
      await fs.symlink(symlinkTarget, nonExistentPath, 'file')
    } catch {
      // Symlinks may require privileges on Windows; skip if unsupported
      return
    }

    // 3. Second call: should resolve the symlink (not a stale cache hit)
    const secondResult = await cachedRealpath(nonExistentPath)
    expect(secondResult).toBe(path.resolve(symlinkTarget))
  })

  it('caches successfully resolved realpaths', async () => {
    const filePath = path.join(tmpDir, 'cacheable.txt')
    await fs.writeFile(filePath, 'hello')

    // First call should cache
    const firstResult = await cachedRealpath(filePath)
    expect(firstResult).toBe(path.resolve(filePath))

    // Second call should hit cache and return same result
    const secondResult = await cachedRealpath(filePath)
    expect(secondResult).toBe(firstResult)
  })

  it('resolves parent directory when file does not exist but parent does', async () => {
    const nonExistentPath = path.join(tmpDir, 'subdir', 'newfile.txt')
    const subdir = path.join(tmpDir, 'subdir')
    await fs.mkdir(subdir, { recursive: true })

    const result = await cachedRealpath(nonExistentPath)
    expect(result).toBe(path.resolve(nonExistentPath))
  })
})
