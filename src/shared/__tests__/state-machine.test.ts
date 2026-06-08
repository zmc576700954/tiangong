import { describe, it, expect } from 'vitest'
import { canTransitionNode, canTransitionBug, validateNodeTransition, validateBugTransition } from '../state-machine'

describe('Node state machine', () => {
  it('allows draft → confirmed', () => {
    expect(canTransitionNode('draft', 'confirmed')).toBe(true)
  })

  it('allows confirmed → developing', () => {
    expect(canTransitionNode('confirmed', 'developing')).toBe(true)
  })

  it('allows placeholder → developing', () => {
    expect(canTransitionNode('placeholder', 'developing')).toBe(true)
  })

  it('allows developing → testing', () => {
    expect(canTransitionNode('developing', 'testing')).toBe(true)
  })

  it('allows testing → review', () => {
    expect(canTransitionNode('testing', 'review')).toBe(true)
  })

  it('allows review → published', () => {
    expect(canTransitionNode('review', 'published')).toBe(true)
  })

  it('allows reverse transitions for corrections', () => {
    expect(canTransitionNode('published', 'review')).toBe(true)
    expect(canTransitionNode('review', 'testing')).toBe(true)
    expect(canTransitionNode('testing', 'developing')).toBe(true)
  })

  it('disallows draft → published (skip)', () => {
    expect(canTransitionNode('draft', 'published')).toBe(false)
  })

  it('disallows draft → testing (skip)', () => {
    expect(canTransitionNode('draft', 'testing')).toBe(false)
  })

  it('validateNodeTransition throws on invalid transition', () => {
    expect(() => validateNodeTransition('draft', 'published')).toThrow('Invalid node status transition')
  })

  it('validateNodeTransition does not throw on valid transition', () => {
    expect(() => validateNodeTransition('draft', 'confirmed')).not.toThrow()
  })
})

describe('Bug state machine', () => {
  it('allows open → fixed', () => {
    expect(canTransitionBug('open', 'fixed')).toBe(true)
  })

  it('allows fixed → verified', () => {
    expect(canTransitionBug('fixed', 'verified')).toBe(true)
  })

  it('allows fixed → open (regression)', () => {
    expect(canTransitionBug('fixed', 'open')).toBe(true)
  })

  it('allows verified → open (regression)', () => {
    expect(canTransitionBug('verified', 'open')).toBe(true)
  })

  it('disallows open → verified (skip)', () => {
    expect(canTransitionBug('open', 'verified')).toBe(false)
  })

  it('validateBugTransition throws on invalid transition', () => {
    expect(() => validateBugTransition('open', 'verified')).toThrow('Invalid bug status transition')
  })
})