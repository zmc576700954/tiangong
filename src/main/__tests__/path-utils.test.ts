import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { isPathWithin, isPathWithinSync } from '../shared/path-utils'

describe('path-utils', () => {
  let tmpDir: string
  let projectDir: string
  let projectEvilDir: string
  let subDir: string
  let outsideFile: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-utils-'))
    projectDir = path.join(tmpDir, 'project')
    projectEvilDir = path.join(tmpDir, 'project-evil')
    subDir = path.join(projectDir, 'src')
    outsideFile = path.join(tmpDir, 'outside.txt')

    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(projectEvilDir, { recursive: true })
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'file.txt'), 'ok')
    await fs.writeFile(path.join(projectEvilDir, 'evil.txt'), 'evil')
    await fs.writeFile(outsideFile, 'outside')
  })

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('isPathWithin (async)', () => {
    it('returns true for the parent directory itself', async () => {
      expect(await isPathWithin(projectDir, projectDir)).toBe(true)
    })

    it('returns true for a direct child file or directory', async () => {
      expect(await isPathWithin(projectDir, path.join(projectDir, 'file.txt'))).toBe(true)
      expect(await isPathWithin(projectDir, subDir)).toBe(true)
    })

    it('rejects .. traversal', async () => {
      expect(await isPathWithin(projectDir, path.join(projectDir, '..', 'outside.txt'))).toBe(false)
      expect(await isPathWithin(projectDir, path.join(projectDir, 'src', '..', '..', 'outside.txt'))).toBe(false)
    })

    it('rejects Windows-style prefix bypass (sibling directory with same prefix)', async () => {
      // `project-evil` starts with `project` but must not be treated as inside it.
      expect(await isPathWithin(projectDir, projectEvilDir)).toBe(false)
      expect(await isPathWithin(projectDir, path.join(projectEvilDir, 'evil.txt'))).toBe(false)
    })

    it('rejects symlink escape from inside the parent', async () => {
      const linkPath = path.join(projectDir, 'escape-link')
      try {
        await fs.symlink(tmpDir, linkPath, process.platform === 'win32' ? 'dir' : 'dir')
      } catch {
        // Symlinks may require privileges on Windows; skip if unsupported.
        return
      }

      try {
        expect(await isPathWithin(projectDir, linkPath)).toBe(false)
        expect(await isPathWithin(projectDir, path.join(linkPath, 'outside.txt'))).toBe(false)
      } finally {
        await fs.unlink(linkPath)
      }
    })

    it('accepts symlink that stays inside the parent', async () => {
      const linkPath = path.join(projectDir, 'inside-link')
      try {
        await fs.symlink(subDir, linkPath, process.platform === 'win32' ? 'dir' : 'dir')
      } catch {
        return
      }

      try {
        expect(await isPathWithin(projectDir, linkPath)).toBe(true)
        expect(await isPathWithin(projectDir, path.join(linkPath, 'nested.txt'))).toBe(true)
      } finally {
        await fs.unlink(linkPath)
      }
    })
  })

  describe('isPathWithinSync', () => {
    it('mirrors the async variant for common cases', () => {
      expect(isPathWithinSync(projectDir, projectDir)).toBe(true)
      expect(isPathWithinSync(projectDir, path.join(projectDir, 'file.txt'))).toBe(true)
      expect(isPathWithinSync(projectDir, path.join(projectDir, '..', 'outside.txt'))).toBe(false)
      expect(isPathWithinSync(projectDir, projectEvilDir)).toBe(false)
    })
  })
})
