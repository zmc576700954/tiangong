import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildSafeEnv, generateId } from '../shared/env'

describe('env utils', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('buildSafeEnv', () => {
    it('preserves PATH', () => {
      process.env.PATH = '/usr/bin'
      const env = buildSafeEnv()
      expect(env.PATH).toBe('/usr/bin')
    })

    it('filters BIZGRAPH_ prefixed variables', () => {
      process.env.BIZGRAPH_SECRET = 'secret'
      const env = buildSafeEnv()
      expect(env.BIZGRAPH_SECRET).toBeUndefined()
    })

    it('filters ELECTRON_ prefixed variables', () => {
      process.env.ELECTRON_FLAG = 'flag'
      const env = buildSafeEnv()
      expect(env.ELECTRON_FLAG).toBeUndefined()
    })

    it('includes ANTHROPIC_ keys for first-party adapters', () => {
      process.env.ANTHROPIC_API_KEY = 'key'
      expect(buildSafeEnv('claude-code').ANTHROPIC_API_KEY).toBe('key')
    })

    it('excludes ANTHROPIC_ keys for unknown adapters', () => {
      process.env.ANTHROPIC_API_KEY = 'key'
      expect(buildSafeEnv('unknown').ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('blocks host-session plumbing CLAUDE_CODE_ vars', () => {
      // 宿主（桌面 App）会话管道变量：声明「认证由宿主管理」。若传给被生成的
      // claude CLI，它会放弃自身认证直接报 Not logged in 退出（实测 exit 1）。
      process.env.CLAUDE_CODE_HOST_AUTH_ENV_VAR = 'ANTHROPIC_AUTH_TOKEN'
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = 'true'
      process.env.CLAUDE_CODE_SESSION_ID = 'sess-1'
      process.env.CLAUDE_CODE_HOST_SESSION_ID = 'host-sess-1'
      process.env.CLAUDE_CODE_MESSAGING_SOCKET = '/tmp/sock'
      const env = buildSafeEnv('claude-code')
      expect(env.CLAUDE_CODE_HOST_AUTH_ENV_VAR).toBeUndefined()
      expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined()
      expect(env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH).toBeUndefined()
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
      expect(env.CLAUDE_CODE_HOST_SESSION_ID).toBeUndefined()
      expect(env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined()
    })

    it('still passes non-plumbing CLAUDE_CODE_ config vars', () => {
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
      expect(buildSafeEnv('claude-code').CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    })
  })

  describe('generateId', () => {
    it('generates prefixed id without dashes', () => {
      const id = generateId('node')
      expect(id.startsWith('node-')).toBe(true)
      expect(id.includes('-', 5)).toBe(false)
    })
  })
})
