import { describe, it, expect } from 'vitest'
import { canTransition, validateTransition, getAllowedTransitions, findTransitionPath, InvalidStateTransitionError } from '../state-machine'

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
