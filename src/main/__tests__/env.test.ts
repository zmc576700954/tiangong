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
  })

  describe('generateId', () => {
    it('generates prefixed id without dashes', () => {
      const id = generateId('node')
      expect(id.startsWith('node-')).toBe(true)
      expect(id.includes('-', 5)).toBe(false)
    })
  })
})
