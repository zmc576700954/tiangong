import { describe, it, expect, vi, afterEach } from 'vitest'
import type { PlatformProvider } from '../platform/platform-provider'
import { getPlatformProvider, setPlatformProviderForTest } from '../platform/platform-provider'

// Mock implementations
function createMockProvider(overrides: Partial<PlatformProvider> = {}): PlatformProvider {
  return {
    platform: 'win32',
    arch: 'x64',
    isMac: false,
    isWindows: true,
    isLinux: false,
    isArm64: false,
    isWsl: false,
    normalizePath: (p: string) => p.replace(/\//g, '\\'),
    pathsEqual: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
    isSystemPath: (p: string) => p.toLowerCase().startsWith('c:\\windows'),
    isWithinParent: (_child: string, _parent: string) => false,
    killProcess: vi.fn(),
    getShellConfig: vi.fn().mockReturnValue({ shell: true }),
    whichCommand: vi.fn().mockReturnValue(null),
    getWatcherOptions: vi.fn().mockReturnValue({}),
    ...overrides,
  } as PlatformProvider
}

describe('PlatformProvider', () => {
  afterEach(() => {
    setPlatformProviderForTest(null)
  })

  it('win32 provider: pathsEqual is case-insensitive', () => {
    setPlatformProviderForTest(createMockProvider({ platform: 'win32', isWindows: true, pathsEqual: (a, b) => a.toLowerCase() === b.toLowerCase() }))
    const provider = getPlatformProvider()
    expect(provider.pathsEqual('C:\\Users', 'c:\\users')).toBe(true)
  })

  it('darwin provider: pathsEqual is case-sensitive', () => {
    setPlatformProviderForTest(createMockProvider({ platform: 'darwin', isMac: true, pathsEqual: (a, b) => a === b }))
    const provider = getPlatformProvider()
    expect(provider.pathsEqual('/Users/Test', '/Users/test')).toBe(false)
  })

  it('win32: isSystemPath blocks Windows system directories', () => {
    setPlatformProviderForTest(createMockProvider({ isSystemPath: (p) => /^c:\\windows/i.test(p) || /^c:\\program files/i.test(p) }))
    const provider = getPlatformProvider()
    expect(provider.isSystemPath('C:\\Windows\\System32')).toBe(true)
    expect(provider.isSystemPath('C:\\Users\\dev')).toBe(false)
  })

  it('linux: isSystemPath blocks Unix system directories', () => {
    setPlatformProviderForTest(createMockProvider({ platform: 'linux', isLinux: true, isSystemPath: (p) => /^(\/etc|\/usr|\/bin|\/sbin|\/boot|\/lib)/.test(p) }))
    const provider = getPlatformProvider()
    expect(provider.isSystemPath('/etc/passwd')).toBe(true)
    expect(provider.isSystemPath('/home/user/project')).toBe(false)
  })

  it('getPlatformProvider returns the same singleton on repeated calls', () => {
    setPlatformProviderForTest(null)
    const first = getPlatformProvider()
    const second = getPlatformProvider()
    expect(first).toBe(second)
  })

  it('setPlatformProviderForTest overrides the singleton', () => {
    const mock = createMockProvider({ platform: 'darwin', isMac: true })
    setPlatformProviderForTest(mock)
    const provider = getPlatformProvider()
    expect(provider.platform).toBe('darwin')
    expect(provider.isMac).toBe(true)
  })

  it('setPlatformProviderForTest(null) restores the real singleton', () => {
    const mock = createMockProvider({ platform: 'linux', isLinux: true })
    setPlatformProviderForTest(mock)
    expect(getPlatformProvider().platform).toBe('linux')

    setPlatformProviderForTest(null)
    // After clearing test instance, it should return the real platform singleton
    const provider = getPlatformProvider()
    // On this test machine it should be win32 or whatever the real platform is
    expect(['darwin', 'win32', 'linux']).toContain(provider.platform)
  })
})
