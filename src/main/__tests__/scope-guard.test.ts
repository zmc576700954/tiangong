/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScopeGuard } from '../scope-guard'
import type { Dirent, Stats } from 'node:fs'
import path from 'node:path'
import { ScopeGuardError } from '../errors'

// ============================================
// Mock 辅助函数
// ============================================

function mockDirent(name: string, isDir = false): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent
}

function mockStats(mtimeMs: number, size: number) {
  return { mtimeMs, size } as Stats
}

// ============================================
// 文件系统状态管理（测试间共享的 mutable state）
// ============================================

type MockFileEntry = { content: string; mtimeMs: number; size: number }

const fsState = {
  dirs: new Map<string, { subdirs: string[]; files: string[] }>(),
  files: new Map<string, MockFileEntry>(),
}

function resetFsState() {
  fsState.dirs.clear()
  fsState.files.clear()
}

function addDir(dirPath: string, subdirs: string[] = [], files: string[] = []) {
  fsState.dirs.set(dirPath, { subdirs, files })
}

function addFile(filePath: string, content: string, mtimeMs: number) {
  fsState.files.set(filePath, { content, mtimeMs, size: Buffer.byteLength(content, 'utf-8') })
}

function removeFile(filePath: string) {
  fsState.files.delete(filePath)
  for (const [, dir] of fsState.dirs) {
    const idx = dir.files.indexOf(path.basename(filePath))
    if (idx !== -1) dir.files.splice(idx, 1)
  }
}

function modifyFile(filePath: string, newContent: string, newMtimeMs: number) {
  const entry = fsState.files.get(filePath)
  if (entry) {
    entry.content = newContent
    entry.mtimeMs = newMtimeMs
    entry.size = Buffer.byteLength(newContent, 'utf-8')
  }
}

// ============================================
// Module Mocks
// ============================================

vi.mock('node:fs/promises', () => {
  return {
    default: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockImplementation((filePath: string) => {
        const entry = fsState.files.get(filePath)
        return Promise.resolve(entry?.content ?? 'default backup content')
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockImplementation((dirPath: string, options?: { withFileTypes?: boolean }) => {
        const dir = fsState.dirs.get(dirPath)
        if (!dir) return Promise.resolve([])
        if (options?.withFileTypes) {
          return Promise.resolve([
            ...dir.subdirs.map(name => mockDirent(name, true)),
            ...dir.files.map(name => mockDirent(name, false)),
          ])
        }
        return Promise.resolve([...dir.subdirs, ...dir.files])
      }),
      stat: vi.fn().mockImplementation((filePath: string) => {
        const entry = fsState.files.get(filePath)
        if (!entry) return Promise.reject(new Error(`ENOENT: ${filePath}`))
        return Promise.resolve(mockStats(entry.mtimeMs, entry.size))
      }),
      unlink: vi.fn().mockResolvedValue(undefined),
      rmdir: vi.fn().mockResolvedValue(undefined),
    },
  }
})

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

// ============================================
// Tests
// ============================================

describe('ScopeGuard', () => {
  let guard: ScopeGuard
  const WORKING_DIR = path.resolve('/project')

  beforeEach(() => {
    guard = new ScopeGuard()
    resetFsState()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ==========================================
  // buildScopeConfig
  // ==========================================
  describe('buildScopeConfig', () => {
    it('should build scope config with all fields', () => {
      const config = ScopeGuard.buildScopeConfig({
        workingDirectory: WORKING_DIR,
        nodeTitle: 'Auth Module',
        acceptanceCriteria: ['User can login', 'Token expires in 1h'],
        allowedFiles: ['src/auth.ts', 'src/login.ts'],
        forbiddenFiles: ['src/payment.ts'],
        invariantRules: ['Must use JWT'],
        upstreamContext: 'User service provides user data',
        downstreamContext: 'Session service stores tokens',
        bugContext: [{ bugId: '1', title: 'Login fail', description: 'Timeout', severity: 'high' }],
      })

      expect(config.workingDirectory).toBe(WORKING_DIR)
      expect(config.nodeTitle).toBe('Auth Module')
      expect(config.acceptanceCriteria).toHaveLength(2)
      expect(config.allowedFiles).toEqual(['src/auth.ts', 'src/login.ts'])
      expect(config.forbiddenFiles).toEqual(['src/payment.ts'])
      expect(config.invariantRules).toEqual(['Must use JWT'])
      expect(config.upstreamContext).toBe('User service provides user data')
      expect(config.downstreamContext).toBe('Session service stores tokens')
      expect(config.bugContext).toHaveLength(1)
    })

    it('should build scope config with defaults', () => {
      const config = ScopeGuard.buildScopeConfig({
        workingDirectory: WORKING_DIR,
        nodeTitle: 'Simple Node',
        acceptanceCriteria: [],
        allowedFiles: [],
      })

      expect(config.forbiddenFiles).toEqual([])
      expect(config.invariantRules).toEqual([])
      expect(config.upstreamContext).toBe('')
      expect(config.downstreamContext).toBe('')
      expect(config.bugContext).toBeUndefined()
    })
  })

  // ==========================================
  // validateChanges
  // ==========================================
  describe('validateChanges', () => {
    it('should validate changes as compliant when all files in whitelist', () => {
      const result = guard.validateChanges(
        ['src/auth.ts', 'src/login.ts'],
        ['src/auth.ts', 'src/login.ts', 'src/utils.ts'],
        WORKING_DIR,
      )

      expect(result.compliant).toBe(true)
      expect(result.outOfBoundsFiles).toHaveLength(0)
      expect(result.validFiles).toHaveLength(2)
      expect(result.validFiles).toContain('src/auth.ts')
      expect(result.validFiles).toContain('src/login.ts')
      expect(result.shouldRollback).toBe(false)
    })

    it('should detect out-of-bounds files', () => {
      const result = guard.validateChanges(
        ['src/auth.ts', 'src/payment.ts'],
        ['src/auth.ts', 'src/login.ts'],
        WORKING_DIR,
      )

      expect(result.compliant).toBe(false)
      expect(result.outOfBoundsFiles).toContain('src/payment.ts')
      expect(result.validFiles).toContain('src/auth.ts')
      expect(result.shouldRollback).toBe(true)
    })

    it('should handle empty change list', () => {
      const result = guard.validateChanges([], ['src/auth.ts'], WORKING_DIR)

      expect(result.compliant).toBe(true)
      expect(result.validFiles).toHaveLength(0)
      expect(result.shouldRollback).toBe(false)
    })

    it('should reject path traversal in allowedFiles', () => {
      expect(() =>
        guard.validateChanges(['src/auth.ts'], ['../etc/passwd'], WORKING_DIR),
      ).toThrow('Path traversal detected')
    })

    it('should reject absolute paths outside working directory', () => {
      expect(() =>
        guard.validateChanges(['src/auth.ts'], ['/etc/passwd'], WORKING_DIR),
      ).toThrow('Path traversal detected')
    })

    it('should reject deep path traversal attempts', () => {
      expect(() =>
        guard.validateChanges(['src/auth.ts'], ['src/../../../etc/passwd'], WORKING_DIR),
      ).toThrow('Path traversal detected')
    })
  })

  // ==========================================
  // prepareSandbox
  // ==========================================
  describe('prepareSandbox', () => {
    it('should prepare sandbox with backup', async () => {
      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'content', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      expect(sandbox.id).toMatch(/^sandbox-/)
      expect(sandbox.workingDir).toBe(WORKING_DIR)
      expect(sandbox.allowedFiles.length).toBe(1)
      expect(sandbox.allowedFiles[0]).toMatch(/src[\\/]auth\.ts$/)
    })

    it('should fallback to workingDir when allowedFiles is empty', async () => {
      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'content', 1000)

      const sandbox = await guard.prepareSandbox([], WORKING_DIR)

      expect(sandbox.allowedFiles).toHaveLength(0)
      expect(sandbox.backupDir).toContain('bizgraph-backups')
    })
  })

  // ==========================================
  // postExecutionValidation — 第三层防御
  // ==========================================
  describe('postExecutionValidation', () => {
    it('should pass when no files changed', async () => {
      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)
      const result = await guard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(true)
      expect(result.outOfBoundsFiles).toHaveLength(0)
      expect(result.newFiles).toHaveLength(0)
      expect(result.shouldRollback).toBe(false)
    })

    it('should allow new files within whitelist', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')
      const loginPath = path.join(WORKING_DIR, 'src', 'login.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts', 'src/login.ts'], WORKING_DIR)

      // Simulate agent creating a new whitelisted file
      addFile(loginPath, 'new', 2000)
      const srcDir = fsState.dirs.get(path.join(WORKING_DIR, 'src'))!
      srcDir.files.push('login.ts')

      const result = await guard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(true)
      expect(result.validFiles).toContain(loginPath)
      expect(result.newFiles).toHaveLength(0)
    })

    it('should detect out-of-bounds new files', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')
      const evilPath = path.join(WORKING_DIR, 'src', 'evil.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Simulate agent creating a file outside whitelist
      addFile(evilPath, 'evil', 2000)
      const srcDir = fsState.dirs.get(path.join(WORKING_DIR, 'src'))!
      srcDir.files.push('evil.ts')

      const result = await guard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(false)
      expect(result.outOfBoundsFiles).toContain(evilPath)
      expect(result.newFiles).toContain(evilPath)
      expect(result.shouldRollback).toBe(true)
    })

    it('should allow modifications to allowed files', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Modify allowed file
      modifyFile(authPath, 'modified', 2000)

      const result = await guard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(true)
      expect(result.validFiles).toContain(authPath)
      expect(result.shouldRollback).toBe(false)
    })

    it('should detect modifications to non-allowed files', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')
      const configPath = path.join(WORKING_DIR, 'src', 'config.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts', 'config.ts'])
      addFile(authPath, 'original', 1000)
      addFile(configPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Modify non-allowed file
      modifyFile(configPath, 'tampered', 2000)

      const result = await guard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(false)
      expect(result.outOfBoundsFiles).toContain(configPath)
      expect(result.shouldRollback).toBe(true)
    })

    it('should allow deletion of allowed files', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Delete allowed file
      removeFile(authPath)

      const result = await guard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(true)
      expect(result.validFiles).toContain(authPath)
    })

    it('should skip validation when initial snapshot is missing', async () => {
      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Simulate missing snapshot by using a fresh guard instance
      const newGuard = new ScopeGuard()
      const result = await newGuard.postExecutionValidation(sandbox)

      expect(result.compliant).toBe(false)
      expect(result.outOfBoundsFiles).toHaveLength(0)
      expect(result.shouldRollback).toBe(true)
    })
  })

  // ==========================================
  // rollback — 回滚与清理
  // ==========================================
  describe('rollback', () => {
    it('should restore backed up files', async () => {
      const fs = await import('node:fs/promises')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      await guard.rollback(sandbox)

      // Verify writeFile was called to restore the backup
      expect(fs.default.writeFile).toHaveBeenCalled()
      const writeCalls = vi.mocked(fs.default.writeFile).mock.calls
      const restoreCall = writeCalls.find(call =>
        typeof call[0] === 'string' && call[0].includes('auth.ts'),
      )
      expect(restoreCall).toBeDefined()
    })

    it('should delete out-of-bounds new files', async () => {
      const fs = await import('node:fs/promises')
      const evilPath = path.join(WORKING_DIR, 'src', 'evil.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      await guard.rollback(sandbox, {
        compliant: false,
        outOfBoundsFiles: [evilPath],
        validFiles: [],
        shouldRollback: true,
        newFiles: [evilPath],
      })

      expect(fs.default.unlink).toHaveBeenCalledWith(evilPath)
    })

    it('should cleanup sandbox resources after rollback', async () => {
      const fs = await import('node:fs/promises')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      await guard.rollback(sandbox)

      // Backup dir should be removed
      expect(fs.default.rm).toHaveBeenCalledWith(
        expect.stringContaining('bizgraph-backups'),
        expect.objectContaining({ recursive: true, force: true }),
      )

      // Verify internal maps are cleaned up
      // @ts-expect-error accessing private field
      expect(guard.sandboxes.has(sandbox.id)).toBe(false)
    })
  })

  // ==========================================
  // commitChanges — 提交变更
  // ==========================================
  describe('commitChanges', () => {
    it('should cleanup sandbox on successful validation', async () => {
      const fs = await import('node:fs/promises')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      const result = await guard.commitChanges(sandbox)

      expect(result.compliant).toBe(true)
      expect(fs.default.rm).toHaveBeenCalled()
      // @ts-expect-error accessing private field
      expect(guard.sandboxes.has(sandbox.id)).toBe(false)
    })

    it('should rollback and throw ScopeGuardError on validation failure', async () => {
      const fs = await import('node:fs/promises')
      const evilPath = path.join(WORKING_DIR, 'src', 'evil.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Simulate agent creating an out-of-bounds file after sandbox preparation
      addFile(evilPath, 'evil', 2000)
      const srcDir = fsState.dirs.get(path.join(WORKING_DIR, 'src'))!
      srcDir.files.push('evil.ts')

      await expect(guard.commitChanges(sandbox)).rejects.toSatisfy((err: Error) => {
        return err instanceof ScopeGuardError && err.message.includes('out-of-bounds')
      })
      expect(fs.default.unlink).toHaveBeenCalledWith(evilPath)
    })

    it('should rollback when out-of-bounds files are detected', async () => {
      const evilPath = path.join(WORKING_DIR, 'src', 'evil.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Simulate agent creating an out-of-bounds file after sandbox preparation
      addFile(evilPath, 'evil', 2000)
      const srcDir = fsState.dirs.get(path.join(WORKING_DIR, 'src'))!
      srcDir.files.push('evil.ts')

      try {
        await guard.commitChanges(sandbox)
      } catch {
        // Expected to throw
      }

      // @ts-expect-error accessing private field
      expect(guard.sandboxes.has(sandbox.id)).toBe(false)
    })
  })

  // ==========================================
  // cleanupSandbox
  // ==========================================
  describe('cleanupSandbox', () => {
    it('should release all resources', async () => {
      const fs = await import('node:fs/promises')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(path.join(WORKING_DIR, 'src', 'auth.ts'), 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // @ts-expect-error accessing private method
      await guard.cleanupSandbox(sandbox)

      // Backup removed
      expect(fs.default.rm).toHaveBeenCalled()
      // Watcher closed
      // @ts-expect-error accessing private field
      expect(guard.watchers.has(sandbox.id)).toBe(false)
      // Snapshot cleared
      // @ts-expect-error accessing private field
      expect(guard.initialSnapshots.has(sandbox.id)).toBe(false)
      // Sandbox removed
      // @ts-expect-error accessing private field
      expect(guard.sandboxes.has(sandbox.id)).toBe(false)
    })
  })

  // ==========================================
  // scanDirectoriesForViolations — 定时扫描
  // ==========================================
  describe('scanDirectoriesForViolations', () => {
    it('should detect out-of-bounds files', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')
      const paymentPath = path.join(WORKING_DIR, 'src', 'payment.ts')

      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts', 'payment.ts'])
      addFile(authPath, '', 0)
      addFile(paymentPath, '', 0)

      // @ts-expect-error accessing private method
      const violations = await guard.scanDirectoriesForViolations(
        new Set([path.join(WORKING_DIR, 'src')]),
        new Set([authPath]),
      )

      expect(violations).toHaveLength(1)
      expect(violations).toContain(paymentPath)
    })

    it('should return empty when no violations', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')

      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, '', 0)

      // @ts-expect-error accessing private method
      const violations = await guard.scanDirectoriesForViolations(
        new Set([path.join(WORKING_DIR, 'src')]),
        new Set([authPath]),
      )

      expect(violations).toHaveLength(0)
    })

    it('should ignore non-file entries', async () => {
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')

      addDir(path.join(WORKING_DIR, 'src'), ['subdir'], ['auth.ts'])
      addFile(authPath, '', 0)

      // @ts-expect-error accessing private method
      const violations = await guard.scanDirectoriesForViolations(
        new Set([path.join(WORKING_DIR, 'src')]),
        new Set([authPath]),
      )

      // subdir is not a file, so it's not counted as a violation
      expect(violations).toHaveLength(0)
    })
  })

  // ==========================================
  // scanLocks — 并发锁
  // ==========================================
  describe('scanLocks', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('should prevent concurrent scans via scanLocks', async () => {
      vi.useFakeTimers()
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Mock scan to never resolve (simulates a stuck scan)
      const scanSpy = vi.spyOn(guard as any, 'scanDirectoriesForViolations').mockImplementation(() => new Promise(() => {}))

      // @ts-expect-error accessing private method
      guard.startActiveScanning(sandbox.id, new Set([authPath]))

      // First interval triggers, scan starts but never completes
      await vi.advanceTimersByTimeAsync(500)
      // @ts-expect-error accessing private field
      expect(guard.scanLocks.has(sandbox.id)).toBe(true)

      // Second and third intervals trigger while scan is running — both should be skipped
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(500)
      expect(scanSpy).toHaveBeenCalledTimes(1)
      // @ts-expect-error accessing private field
      expect(guard.scanLocks.has(sandbox.id)).toBe(true)

      // Cleanup
      // @ts-expect-error accessing private method
      guard.stopActiveScanning(sandbox.id)
    })

    it('should release lock when sandbox is removed during scan', async () => {
      vi.useFakeTimers()
      const authPath = path.join(WORKING_DIR, 'src', 'auth.ts')

      addDir(WORKING_DIR, ['src'])
      addDir(path.join(WORKING_DIR, 'src'), [], ['auth.ts'])
      addFile(authPath, 'original', 1000)

      const sandbox = await guard.prepareSandbox(['src/auth.ts'], WORKING_DIR)

      // Make scan slow so we can remove sandbox while it's running
      vi.spyOn(guard as any, 'scanDirectoriesForViolations').mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 1000))
        return []
      })

      // @ts-expect-error accessing private method
      guard.startActiveScanning(sandbox.id, new Set([authPath]))

      // Start the scan (sets lock)
      await vi.advanceTimersByTimeAsync(500)
      // @ts-expect-error accessing private field
      expect(guard.scanLocks.has(sandbox.id)).toBe(true)

      // Remove sandbox mid-scan
      // @ts-expect-error accessing private field
      guard.sandboxes.delete(sandbox.id)

      // Let the scan callback finish
      await vi.advanceTimersByTimeAsync(1000)
      // Lock should be cleaned up
      // @ts-expect-error accessing private field
      expect(guard.scanLocks.has(sandbox.id)).toBe(false)

      // Cleanup
      // @ts-expect-error accessing private method
      guard.stopActiveScanning(sandbox.id)
    })
  })
})
