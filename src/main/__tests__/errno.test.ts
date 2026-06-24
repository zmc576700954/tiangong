import { describe, it, expect } from 'vitest'
import { isErrorWithCode } from '../shared/errno'

describe('isErrorWithCode', () => {
  it('returns true for an Error with a code property', () => {
    const err = new Error('disk full') as NodeJS.ErrnoException
    err.code = 'ENOSPC'
    expect(isErrorWithCode(err)).toBe(true)
  })

  it('returns false for a plain Error without code', () => {
    expect(isErrorWithCode(new Error('oops'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isErrorWithCode(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isErrorWithCode(undefined)).toBe(false)
  })

  it('returns false for a string', () => {
    expect(isErrorWithCode('something broke')).toBe(false)
  })

  it('returns false for a number', () => {
    expect(isErrorWithCode(42)).toBe(false)
  })

  it('returns false for a plain object with code property', () => {
    // Must be an Error instance — a plain object fails instanceof Error
    expect(isErrorWithCode({ code: 'ENOENT' })).toBe(false)
  })

  it('narrows type so err.code is accessible', () => {
    const err: unknown = new Error('not found') as NodeJS.ErrnoException
    ;(err as NodeJS.ErrnoException).code = 'ENOENT'

    if (isErrorWithCode(err)) {
      // TypeScript narrows err to NodeJS.ErrnoException here
      expect(err.code).toBe('ENOENT')
    } else {
      // Should not reach this branch
      expect.unreachable('Expected isErrorWithCode to return true')
    }
  })

  it('returns true for a custom Error subclass with code', () => {
    // isErrorWithCode matches any Error with a `code` property,
    // not just Node.js system errors — this is by design.
    class AppError extends Error {
      code = 'APP_001'
    }
    expect(isErrorWithCode(new AppError('app failure'))).toBe(true)
  })
})
