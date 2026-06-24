import { describe, it, expect } from 'vitest'
import { safeJsonParse, safeRowId } from '../shared/db-utils'

describe('safeJsonParse', () => {
  it('returns parsed value for valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 })
  })

  it('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('not-json', { fallback: true })).toEqual({ fallback: true })
  })

  it('returns fallback for null/undefined input', () => {
    expect(safeJsonParse(null, [])).toEqual([])
    expect(safeJsonParse(undefined, [])).toEqual([])
  })

  it('uses validator when provided', () => {
    const isStringArray = (val: unknown): val is string[] => Array.isArray(val) && val.every((v) => typeof v === 'string')
    expect(safeJsonParse('["a","b"]', [], isStringArray)).toEqual(['a', 'b'])
    expect(safeJsonParse('[1,2]', [], isStringArray)).toEqual([])
  })
})

describe('safeRowId', () => {
  it('converts number to number', () => {
    expect(safeRowId(42)).toBe(42)
  })

  it('converts numeric string to number', () => {
    expect(safeRowId('42')).toBe(42)
  })

  it('converts bigint within safe range to number', () => {
    expect(safeRowId(42n)).toBe(42)
    expect(safeRowId(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('throws for bigint exceeding safe integer range', () => {
    const unsafeId = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    expect(() => safeRowId(unsafeId)).toThrow('exceeds Number.MAX_SAFE_INTEGER')
  })

  it('throws for non-numeric values', () => {
    expect(() => safeRowId('not-a-number')).toThrow('Invalid row id')
    expect(() => safeRowId(NaN)).toThrow('Invalid row id')
    expect(() => safeRowId(undefined)).toThrow('Invalid row id')
  })

  it('converts null to 0', () => {
    expect(safeRowId(null)).toBe(0)
  })
})
