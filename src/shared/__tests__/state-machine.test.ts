import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  canTransition,
  validateTransition,
  getAllowedTransitions,
  findTransitionPath,
  InvalidStateTransitionError,
  canBugTransition,
  validateBugTransition,
  validateTransitionConsistency,
} from '../state-machine'

describe('canTransition', () => {
  it('allows draft → confirmed', () => {
    expect(canTransition('draft', 'confirmed')).toBe(true)
  })

  it('allows confirmed → developing', () => {
    expect(canTransition('confirmed', 'developing')).toBe(true)
  })

  it('allows developing → testing', () => {
    expect(canTransition('developing', 'testing')).toBe(true)
  })

  it('allows testing → review', () => {
    expect(canTransition('testing', 'review')).toBe(true)
  })

  it('allows review → published', () => {
    expect(canTransition('review', 'published')).toBe(true)
  })

  it('blocks illegal transition: published → developing', () => {
    expect(canTransition('published', 'developing')).toBe(false)
  })

  it('blocks illegal transition: draft → published', () => {
    expect(canTransition('draft', 'published')).toBe(false)
  })

  it('allows same state (no-op)', () => {
    expect(canTransition('confirmed', 'confirmed')).toBe(true)
  })

  it('allows placeholder → draft', () => {
    expect(canTransition('placeholder', 'draft')).toBe(true)
  })

  it('allows placeholder → confirmed', () => {
    expect(canTransition('placeholder', 'confirmed')).toBe(true)
  })
})

describe('validateTransition', () => {
  it('throws on illegal transition', () => {
    expect(() => validateTransition('draft', 'published', 'node-1')).toThrow(InvalidStateTransitionError)
  })

  it('does not throw on legal transition', () => {
    expect(() => validateTransition('draft', 'confirmed')).not.toThrow()
  })
})

describe('getAllowedTransitions', () => {
  it('returns correct transitions from confirmed', () => {
    const transitions = getAllowedTransitions('confirmed')
    expect(transitions).toContain('developing')
    expect(transitions).toContain('draft')
    expect(transitions).toContain('placeholder')
    expect(transitions).not.toContain('published')
  })
})

describe('findTransitionPath', () => {
  it('returns direct path for legal direct transition', () => {
    expect(findTransitionPath('draft', 'confirmed')).toEqual(['draft', 'confirmed'])
  })

  it('returns multi-step path when indirect', () => {
    const path = findTransitionPath('published', 'draft')
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(2)
    expect(path![0]).toBe('published')
    expect(path![path!.length - 1]).toBe('draft')
  })
})

describe('canBugTransition', () => {
  it('allows open → fixed', () => {
    expect(canBugTransition('open', 'fixed')).toBe(true)
  })

  it('allows fixed → verified', () => {
    expect(canBugTransition('fixed', 'verified')).toBe(true)
  })

  it('allows fixed → open (reopen)', () => {
    expect(canBugTransition('fixed', 'open')).toBe(true)
  })

  it('allows verified → open (reopen)', () => {
    expect(canBugTransition('verified', 'open')).toBe(true)
  })

  it('blocks open → verified (must pass fixed)', () => {
    expect(canBugTransition('open', 'verified')).toBe(false)
  })

  it('allows same state (no-op)', () => {
    expect(canBugTransition('open', 'open')).toBe(true)
    expect(canBugTransition('verified', 'verified')).toBe(true)
  })
})

describe('validateBugTransition', () => {
  it('throws on illegal bug transition', () => {
    expect(() => validateBugTransition('open', 'verified', 'bug-1')).toThrow(InvalidStateTransitionError)
  })

  it('does not throw on legal bug transition', () => {
    expect(() => validateBugTransition('open', 'fixed')).not.toThrow()
  })

  it('includes bugId in error message when provided', () => {
    expect(() => validateBugTransition('open', 'verified', 'bug-1')).toThrow('bug-1')
  })
})

describe('validateTransitionConsistency', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('returns 0 when rules are consistent', () => {
    expect(validateTransitionConsistency()).toBe(0)
    expect(consoleSpy).not.toHaveBeenCalled()
  })
})
