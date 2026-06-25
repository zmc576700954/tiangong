/**
 * Platform Provider — abstraction layer for platform-specific operations
 *
 * Centralizes all platform logic (path comparison, system paths, process
 * management, shell config, watcher options) so that it can be tested
 * and maintained in one place instead of being scattered across the codebase.
 */

import { type ChildProcess } from 'node:child_process'
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
  getShellConfig(): Partial<import('node:child_process').SpawnOptions>

  whichCommand(cmd: string): string | null

  getWatcherOptions(): Record<string, unknown>
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
  getShellConfig(): Partial<import('node:child_process').SpawnOptions> { return {} }
  whichCommand(cmd: string): string | null {
    try { return require('child_process').execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> { return {} }
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
  getShellConfig(): Partial<import('node:child_process').SpawnOptions> { return { shell: true } }
  whichCommand(cmd: string): string | null {
    try { return require('child_process').execSync(`where ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> { return {} }
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
  getShellConfig(): Partial<import('node:child_process').SpawnOptions> { return {} }
  whichCommand(cmd: string): string | null {
    try { return require('child_process').execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() } catch { return null }
  }
  getWatcherOptions(): Record<string, unknown> {
    return this.isWsl ? { usePolling: true } : {}
  }
}
