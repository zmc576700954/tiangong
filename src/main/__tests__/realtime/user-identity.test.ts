import { describe, it, expect } from 'vitest'
import {
  AWARENESS_COLOR_PALETTE,
  deriveColorIndex,
  generateDefaultIdentity,
  isHexColor,
  isValidUserIdentity,
  resolveAwarenessColor,
} from '../../realtime/user-identity'

describe('resolveAwarenessColor', () => {
  it('returns palette entry for valid colorIndex', () => {
    expect(resolveAwarenessColor(0)).toBe(AWARENESS_COLOR_PALETTE[0])
    expect(resolveAwarenessColor(3)).toBe(AWARENESS_COLOR_PALETTE[3])
    expect(resolveAwarenessColor(5)).toBe(AWARENESS_COLOR_PALETTE[5])
  })

  it('wraps around for indices beyond palette length', () => {
    expect(resolveAwarenessColor(6)).toBe(AWARENESS_COLOR_PALETTE[0])
    expect(resolveAwarenessColor(11)).toBe(AWARENESS_COLOR_PALETTE[5])
  })

  it('falls back to palette[0] for negative or non-finite indices', () => {
    expect(resolveAwarenessColor(-1)).toBe(AWARENESS_COLOR_PALETTE[0])
    expect(resolveAwarenessColor(NaN)).toBe(AWARENESS_COLOR_PALETTE[0])
    expect(resolveAwarenessColor(Infinity)).toBe(AWARENESS_COLOR_PALETTE[0])
  })

  it('returns valid hex colors', () => {
    for (let i = 0; i < AWARENESS_COLOR_PALETTE.length; i++) {
      expect(isHexColor(resolveAwarenessColor(i))).toBe(true)
    }
  })
})

describe('deriveColorIndex', () => {
  it('produces a stable index for the same seed', () => {
    const seed = 'face-sm-7c4d-b3b7-4c1a-9f0e-aaaaaaaaaaaa'
    const a = deriveColorIndex(seed)
    const b = deriveColorIndex(seed)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(AWARENESS_COLOR_PALETTE.length)
  })

  it('returns 0 for empty seed (no crash)', () => {
    expect(deriveColorIndex('')).toBe(0)
  })

  it('produces different indices for distinct seeds', () => {
    const seeds = [
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '11111111-2222-3333-4444-555555555555',
      'face-face-face-face-face-face-face',
    ]
    const indices = seeds.map(deriveColorIndex)
    // At least 2 of 3 should be distinct (hash collision is possible but rare)
    const unique = new Set(indices)
    expect(unique.size).toBeGreaterThanOrEqual(2)
  })
})

describe('generateDefaultIdentity', () => {
  it('returns a valid identity with non-empty fields', () => {
    const id = generateDefaultIdentity()
    expect(id.userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(id.userName.length).toBeGreaterThan(0)
    expect(id.colorIndex).toBeGreaterThanOrEqual(0)
    expect(id.colorIndex).toBeLessThan(AWARENESS_COLOR_PALETTE.length)
  })

  it('returns distinct identities on repeated calls', () => {
    const a = generateDefaultIdentity()
    const b = generateDefaultIdentity()
    expect(a.userId).not.toBe(b.userId)
  })

  it('uses deterministic color index derived from userId', () => {
    const id = generateDefaultIdentity()
    expect(id.colorIndex).toBe(deriveColorIndex(id.userId))
  })
})

describe('isValidUserIdentity', () => {
  it('accepts a freshly generated identity', () => {
    expect(isValidUserIdentity(generateDefaultIdentity())).toBe(true)
  })

  it('rejects non-objects', () => {
    expect(isValidUserIdentity(null)).toBe(false)
    expect(isValidUserIdentity(undefined)).toBe(false)
    expect(isValidUserIdentity('string')).toBe(false)
    expect(isValidUserIdentity(42)).toBe(false)
  })

  it('rejects missing or empty fields', () => {
    expect(isValidUserIdentity({ userId: '', userName: 'x', colorIndex: 0 })).toBe(false)
    expect(isValidUserIdentity({ userId: 'a', userName: '', colorIndex: 0 })).toBe(false)
  })

  it('rejects fields exceeding size limits', () => {
    expect(isValidUserIdentity({
      userId: 'x'.repeat(129),
      userName: 'ok',
      colorIndex: 0,
    })).toBe(false)
    expect(isValidUserIdentity({
      userId: 'ok',
      userName: 'x'.repeat(65),
      colorIndex: 0,
    })).toBe(false)
  })

  it('rejects negative or non-integer colorIndex', () => {
    expect(isValidUserIdentity({
      userId: 'a', userName: 'b', colorIndex: -1,
    })).toBe(false)
    expect(isValidUserIdentity({
      userId: 'a', userName: 'b', colorIndex: 1.5,
    })).toBe(false)
  })

  it('rejects colorIndex out of palette range', () => {
    expect(isValidUserIdentity({
      userId: 'a', userName: 'b', colorIndex: 99,
    })).toBe(false)
  })
})

describe('isHexColor', () => {
  it('accepts 6-digit hex', () => {
    expect(isHexColor('#ffffff')).toBe(true)
    expect(isHexColor('#000000')).toBe(true)
    expect(isHexColor('#abcdef')).toBe(true)
  })

  it('rejects named colors', () => {
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor('rgb(0,0,0)')).toBe(false)
  })

  it('rejects 3-digit hex (must be 6)', () => {
    expect(isHexColor('#fff')).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isHexColor(null)).toBe(false)
    expect(isHexColor(0xffffff)).toBe(false)
  })
})