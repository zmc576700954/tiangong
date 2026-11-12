import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { isPathWithin, isPathWithinSync, safeRealpathSync } from '../shared/path-utils'

/**
 * `/tmp` 是否存在且是指向别处的符号链接。
 *
 * 这两条用例验的是「路径还没创建时，先 realpath 最近的存在祖先」—— 只在 macOS
 * 这种 `/tmp → /private/tmp` 的宿主上才有意义。Windows 上 `/tmp` 会被解析成
 * `C:\tmp`、通常不存在，`realpathSync` 直接抛 ENOENT；原先没有 try/catch，
 * 于是「跑在 Windows 上」本身就变成一条失败（G9-13 接 Windows CI 时暴露）。
 *
 * @returns 真实目录；不存在、或本身不是符号链接（无该差异）时返回 null
 */
function realTmpIfSymlinked(): string | null {
  try {
    const real = fsSync.realpathSync('/tmp')
    return real === '/tmp' ? null : real
  } catch {
    return null
  }
}

describe('path-utils', () => {
  let tmpDir: string
  let projectDir: string
  let projectEvilDir: string
  let subDir: string
  let outsideFile: string
  let dotdotNamedFile: string

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-utils-'))
    projectDir = path.join(tmpDir, 'project')
    projectEvilDir = path.join(tmpDir, 'project-evil')
    subDir = path.join(projectDir, 'src')
    outsideFile = path.join(tmpDir, 'outside.txt')
    dotdotNamedFile = path.join(projectDir, '..foo.txt')

    await fs.mkdir(projectDir, { recursive: true })
    await fs.mkdir(projectEvilDir, { recursive: true })
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'file.txt'), 'ok')
    await fs.writeFile(path.join(projectEvilDir, 'evil.txt'), 'evil')
    await fs.writeFile(outsideFile, 'outside')
    await fs.writeFile(dotdotNamedFile, 'not traversal')
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

    it('allows files whose names start with .. (not traversal)', async () => {
      expect(await isPathWithin(projectDir, dotdotNamedFile)).toBe(true)
    })

    it('rejects Windows-style prefix bypass (sibling directory with same prefix)', async () => {
      // `project-evil` starts with `project` but must not be treated as inside it.
      expect(await isPathWithin(projectDir, projectEvilDir)).toBe(false)
      expect(await isPathWithin(projectDir, path.join(projectEvilDir, 'evil.txt'))).toBe(false)
    })

    it('rejects symlink escape from inside the parent', async () => {
      const linkPath = path.join(projectDir, 'escape-link')
      try {
        await fs.symlink(tmpDir, linkPath, 'dir')
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
        await fs.symlink(subDir, linkPath, 'dir')
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

    it('resolves not-yet-created paths under a symlinked ancestor consistently (macOS /tmp)', async () => {
      const realTmp = realTmpIfSymlinked()
      if (realTmp === null) return

      const uniqueName = `path-utils-async-ancestor-${process.pid}-${Date.now()}`
      const viaTmp = path.join('/tmp', uniqueName, 'artifacts', 'ok.txt')
      expect(await isPathWithin(realTmp, viaTmp)).toBe(true)
    })
  })

  describe('isPathWithinSync', () => {
    it('mirrors the async variant for common cases', () => {
      expect(isPathWithinSync(projectDir, projectDir)).toBe(true)
      expect(isPathWithinSync(projectDir, path.join(projectDir, 'file.txt'))).toBe(true)
      expect(isPathWithinSync(projectDir, path.join(projectDir, '..', 'outside.txt'))).toBe(false)
      expect(isPathWithinSync(projectDir, projectEvilDir)).toBe(false)
      expect(isPathWithinSync(projectDir, dotdotNamedFile)).toBe(true)
    })

    it('rejects symlink escape from inside the parent', () => {
      const linkPath = path.join(projectDir, 'escape-link-sync')
      try {
        fsSync.symlinkSync(tmpDir, linkPath, 'dir')
      } catch {
        return
      }

      try {
        expect(isPathWithinSync(projectDir, linkPath)).toBe(false)
        expect(isPathWithinSync(projectDir, path.join(linkPath, 'outside.txt'))).toBe(false)
      } finally {
        fsSync.unlinkSync(linkPath)
      }
    })

    it('accepts symlink that stays inside the parent', () => {
      const linkPath = path.join(projectDir, 'inside-link-sync')
      try {
        fsSync.symlinkSync(subDir, linkPath, 'dir')
      } catch {
        return
      }

      try {
        expect(isPathWithinSync(projectDir, linkPath)).toBe(true)
      } finally {
        fsSync.unlinkSync(linkPath)
      }
    })

    it('resolves a not-yet-created path through the nearest symlinked ancestor (macOS /tmp)', () => {
      // macOS 上 /tmp 是指向 /private/tmp 的符号链接；白名单在文件尚未创建时
      // 解析，若退化为 path.resolve 就会留下 /tmp/...，与创建后 realpath 的
      // /private/tmp/... 对不上，导致 ScopeGuard 误判越界。
      const realTmp = realTmpIfSymlinked()
      if (realTmp === null) {
        // 非符号链接平台（Windows / Linux）无此差异，跳过（不影响其余断言）。
        return
      }

      const uniqueName = `path-utils-symlink-ancestor-${process.pid}-${Date.now()}`
      const viaTmp = path.join('/tmp', uniqueName, 'artifacts', 'ok.txt')
      const expected = path.join(realTmp, uniqueName, 'artifacts', 'ok.txt')

      expect(safeRealpathSync(viaTmp)).toBe(expected)

      // 创建后两侧口径必须仍然一致（这正是演练断点所缺的等价性）。
      try {
        fsSync.mkdirSync(path.dirname(path.join('/tmp', uniqueName)), { recursive: true })
        fsSync.mkdirSync(path.dirname(viaTmp), { recursive: true })
        fsSync.writeFileSync(viaTmp, 'ok')
        expect(fsSync.realpathSync(viaTmp)).toBe(expected)
        expect(safeRealpathSync(viaTmp)).toBe(expected)
      } finally {
        fsSync.rmSync(path.join('/tmp', uniqueName), { recursive: true, force: true })
      }
    })

    it('still rejects a not-yet-created path that escapes through a symlink', () => {
      // 反向往例（安全边界）：不因「最近已存在祖先」改动把不存在路径当成放行。
      // 工作目录内的符号链接指向外部，其下尚未创建的文件也不能落进白名单。
      const outsideDir = path.join(tmpDir, 'outside-dir')
      fsSync.mkdirSync(outsideDir, { recursive: true })
      const escapeLink = path.join(projectDir, 'escape-link-hypothetical')
      try {
        fsSync.symlinkSync(outsideDir, escapeLink, 'dir')
      } catch {
        return
      }

      try {
        const hypothetical = path.join(escapeLink, 'new.txt')
        expect(fsSync.existsSync(hypothetical)).toBe(false)
        expect(isPathWithinSync(projectDir, hypothetical)).toBe(false)
        // 文件真的出现后仍然必须判越界。
        fsSync.writeFileSync(hypothetical, 'escaped')
        expect(isPathWithinSync(projectDir, hypothetical)).toBe(false)
      } finally {
        fsSync.rmSync(escapeLink, { recursive: true, force: true })
        fsSync.rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })
})
