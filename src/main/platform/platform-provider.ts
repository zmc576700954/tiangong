/**
 * Platform Provider — abstraction layer for platform-specific operations
 *
 * Centralizes all platform logic (path comparison, system paths, process
 * management, shell config, watcher options) so that it can be tested
 * and maintained in one place instead of being scattered across the codebase.
 */

import { type ChildProcess, type SpawnOptions, execSync, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface PlatformProvider {
  readonly platform: 'darwin' | 'win32' | 'linux'
  readonly arch: 'x64' | 'arm64'
  readonly isMac: boolean
  readonly isWindows: boolean
  readonly isLinux: boolean
  readonly isArm64: boolean
  readonly isWsl: boolean

  normalizePath(p: string): string
  pathsEqual(a: string, b: string): boolean
  isSystemPath(p: string): boolean
  isWithinParent(child: string, parent: string): boolean

  killProcess(proc: ChildProcess): void
  getShellConfig(): Partial<SpawnOptions>

  whichCommand(cmd: string): string | null

  getWatcherOptions(): Record<string, unknown>

  /**
   * Restrict a file so only the current OS user can read/write it.
   *
   * On POSIX the caller is expected to have already created the file with mode
   * 0o600 (which is honoured), so this is a no-op. On Windows POSIX mode bits are
   * ignored by the filesystem, so this tightens the ACL via `icacls`: inheritance
   * is removed and only the current user is granted full control. Best-effort:
   * returns true on success, false if the ACL change could not be applied.
   */
  restrictFileToCurrentUser(filePath: string): boolean
}

let instance: PlatformProvider | null = null
let testInstance: PlatformProvider | null = null

export function setPlatformProviderForTest(provider: PlatformProvider | null): void {
  testInstance = provider
}

export function getPlatformProvider(): PlatformProvider {
  if (testInstance) return testInstance
  if (instance) return instance
  const platform = process.platform as 'darwin' | 'win32' | 'linux'
  const arch = process.arch as 'x64' | 'arm64'
  const isWsl = platform === 'linux' && !!process.env.WSL_DISTRO_NAME

  switch (platform) {
    case 'darwin':
      instance = new DarwinProvider(arch)
      break
    case 'win32':
      instance = new Win32Provider(arch)
      break
    case 'linux':
      instance = new LinuxProvider(arch, isWsl)
      break
    default:
      throw new Error(`Unsupported platform: ${platform}`)
  }
  return instance
}

// --- Darwin ---

class DarwinProvider implements PlatformProvider {
  readonly platform = 'darwin' as const
  readonly isMac = true
  readonly isWindows = false
  readonly isLinux = false
  readonly isWsl = false

  constructor(public readonly arch: 'x64' | 'arm64') {}
  get isArm64() { return this.arch === 'arm64' }

  normalizePath(p: string) { return p }
  pathsEqual(a: string, b: string) { return a === b }

  isSystemPath(p: string): boolean {
    const resolved = path.resolve(p)
    return /^(\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib|\/var)/.test(resolved) || resolved === '/'
  }

  isWithinParent(child: string, parent: string): boolean {
    const rel = path.relative(parent, child)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  killProcess(proc: ChildProcess): void { proc.kill('SIGTERM') }
  getShellConfig(): Partial<SpawnOptions> { return {} }
  whichCommand(cmd: string): string | null {
    try { return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> { return {} }
  restrictFileToCurrentUser(_filePath: string): boolean { return true }
}

// --- Win32 ---

class Win32Provider implements PlatformProvider {
  readonly platform = 'win32' as const
  readonly isMac = false
  readonly isWindows = true
  readonly isLinux = false
  readonly isWsl = false

  constructor(public readonly arch: 'x64' | 'arm64') {}
  get isArm64() { return this.arch === 'arm64' }

  normalizePath(p: string) { return p.replace(/\//g, '\\') }
  pathsEqual(a: string, b: string) { return a.toLowerCase() === b.toLowerCase() }

  isSystemPath(p: string): boolean {
    const lower = p.toLowerCase()
    return lower.startsWith('c:\\windows') ||
      lower.startsWith('c:\\program files') ||
      lower.startsWith('c:\\program files (x86)') ||
      lower.startsWith('c:\\programdata')
  }

  isWithinParent(child: string, parent: string): boolean {
    const rel = path.relative(parent, child)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  killProcess(proc: ChildProcess): void { proc.kill() }
  getShellConfig(): Partial<SpawnOptions> { return { shell: true } }
  whichCommand(cmd: string): string | null {
    try { return execSync(`where ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> { return {} }

  restrictFileToCurrentUser(filePath: string): boolean {
    // Windows ignores POSIX mode bits, so tighten the DACL explicitly:
    //   /inheritance:r  — remove inherited ACEs (drops broad group access)
    //   /grant:r <user>:F — replace this user's ACEs with Full control only
    // Invoked via spawnSync with an argument array (no shell) to avoid injection;
    // the username comes from the OS, not from external input.
    try {
      const username = os.userInfo().username
      if (!username) return false
      const result = spawnSync(
        'icacls',
        [filePath, '/inheritance:r', '/grant:r', `${username}:F`],
        { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
      )
      return !result.error && result.status === 0
    } catch {
      return false
    }
  }
}

// --- Linux (incl. WSL) ---

class LinuxProvider implements PlatformProvider {
  readonly platform = 'linux' as const
  readonly isMac = false
  readonly isWindows = false
  readonly isLinux = true

  constructor(public readonly arch: 'x64' | 'arm64', public readonly isWsl: boolean) {}
  get isArm64() { return this.arch === 'arm64' }

  normalizePath(p: string) { return p }
  pathsEqual(a: string, b: string) { return a === b }

  isSystemPath(p: string): boolean {
    const resolved = path.resolve(p)
    return /^(\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib|\/var)/.test(resolved) || resolved === '/'
  }

  isWithinParent(child: string, parent: string): boolean {
    const rel = path.relative(parent, child)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  killProcess(proc: ChildProcess): void { proc.kill('SIGTERM') }
  getShellConfig(): Partial<SpawnOptions> { return {} }
  whichCommand(cmd: string): string | null {
    try { return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> {
    return this.isWsl ? { usePolling: true } : {}
  }
  restrictFileToCurrentUser(_filePath: string): boolean { return true }
}
