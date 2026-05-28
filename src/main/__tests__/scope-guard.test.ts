import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScopeGuard } from '../scope-guard'

// Mock fs and chokidar
vi.mock('node:fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('file content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

describe('ScopeGuard', () => {
  let guard: ScopeGuard

  beforeEach(() => {
    guard = new ScopeGuard()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should build scope config with all fields', () => {
    const config = guard.buildScopeConfig({
      workingDirectory: '/project',
      nodeTitle: 'Auth Module',
      acceptanceCriteria: ['User can login', 'Token expires in 1h'],
      allowedFiles: ['src/auth.ts', 'src/login.ts'],
      forbiddenFiles: ['src/payment.ts'],
      invariantRules: ['Must use JWT'],
      upstreamContext: 'User service provides user data',
      downstreamContext: 'Session service stores tokens',
      bugContext: [{ bugId: '1', title: 'Login fail', description: 'Timeout', severity: 'high' }],
    })

    expect(config.workingDirectory).toBe('/project')
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
    const config = guard.buildScopeConfig({
      workingDirectory: '/project',
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

  it('should validate changes as compliant when all files in whitelist', () => {
    const result = guard.validateChanges(
      ['src/auth.ts', 'src/login.ts'],
      ['src/auth.ts', 'src/login.ts', 'src/utils.ts'],
      '/project',
    )

    expect(result.compliant).toBe(true)
    expect(result.outOfBoundsFiles).toHaveLength(0)
    expect(result.validFiles).toHaveLength(2)
    expect(result.shouldRollback).toBe(false)
  })

  it('should detect out-of-bounds files', () => {
    const result = guard.validateChanges(
      ['src/auth.ts', 'src/payment.ts'],
      ['src/auth.ts', 'src/login.ts'],
      '/project',
    )

    expect(result.compliant).toBe(false)
    expect(result.outOfBoundsFiles).toContain('src/payment.ts')
    expect(result.validFiles).toContain('src/auth.ts')
    expect(result.shouldRollback).toBe(true)
  })

  it('should handle empty change list', () => {
    const result = guard.validateChanges([], ['src/auth.ts'], '/project')

    expect(result.compliant).toBe(true)
    expect(result.validFiles).toHaveLength(0)
    expect(result.shouldRollback).toBe(false)
  })

  it('should reject path traversal in allowedFiles', () => {
    expect(() =>
      guard.validateChanges(['src/auth.ts'], ['../etc/passwd'], '/project'),
    ).toThrow('Path traversal detected')
  })

  it('should prepare sandbox with backup', async () => {
    const sandbox = await guard.prepareSandbox(['src/auth.ts'], '/project')

    expect(sandbox.id).toMatch(/^sandbox-/)
    expect(sandbox.workingDir).toBe('/project')
    expect(sandbox.allowedFiles.length).toBe(1)
    expect(sandbox.allowedFiles[0]).toMatch(/src[\\/]auth\.ts$/)
  })
})
