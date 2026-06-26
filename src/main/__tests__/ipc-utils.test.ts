import { describe, it, expect } from 'vitest'
import { ensureString, ensureOptionalNumber, isPathWithinProject } from '../ipc/utils'
import { IpcError } from '../errors'

describe('ipc utils', () => {
  describe('ensureString', () => {
    it('returns valid string', () => {
      expect(ensureString('name', 'hello')).toBe('hello')
    })

    it('throws for non-string', () => {
      expect(() => ensureString('name', 123)).toThrow(IpcError)
    })

    it('throws for empty string', () => {
      expect(() => ensureString('name', '')).toThrow(IpcError)
    })

    it('throws for overly long string', () => {
      expect(() => ensureString('name', 'a'.repeat(100), 64)).toThrow(IpcError)
    })
  })

  describe('ensureOptionalNumber', () => {
    it('returns number', () => {
      expect(ensureOptionalNumber('count', 5)).toBe(5)
    })

    it('returns undefined for null/undefined', () => {
      expect(ensureOptionalNumber('count', null)).toBeUndefined()
      expect(ensureOptionalNumber('count', undefined)).toBeUndefined()
    })

    it('throws for non-number', () => {
      expect(() => ensureOptionalNumber('count', '5')).toThrow(IpcError)
    })
  })

  describe('isPathWithinProject', () => {
    it('returns true for file inside project', () => {
      expect(isPathWithinProject('src/index.ts', '/project')).toBe(true)
    })

    it('returns false for traversal outside project', () => {
      expect(isPathWithinProject('../../../etc/passwd', '/project')).toBe(false)
    })
  })
})
