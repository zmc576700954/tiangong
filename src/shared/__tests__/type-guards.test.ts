import { describe, it, expect } from 'vitest'
import {
  isNodeStatus, isNodeType, isGraphType, isEdgeType, isBugSeverity, isBugStatus,
  assertNodeStatus, assertGraphType, assertBugSeverity, assertBugStatus,
} from '../type-guards'

describe('type guards', () => {
  it('isNodeStatus accepts valid values', () => {
    expect(isNodeStatus('draft')).toBe(true)
    expect(isNodeStatus('published')).toBe(true)
    expect(isNodeStatus('invalid')).toBe(false)
    expect(isNodeStatus('')).toBe(false)
  })

  it('isNodeType accepts valid values', () => {
    expect(isNodeType('module')).toBe(true)
    expect(isNodeType('unknown')).toBe(false)
  })

  it('isGraphType accepts valid values', () => {
    expect(isGraphType('online')).toBe(true)
    expect(isGraphType('dev')).toBe(true)
    expect(isGraphType('staging')).toBe(false)
  })

  it('isEdgeType accepts valid values', () => {
    expect(isEdgeType('default')).toBe(true)
    expect(isEdgeType('business-flow')).toBe(true)
    expect(isEdgeType('random')).toBe(false)
  })

  it('isBugSeverity accepts valid values', () => {
    expect(isBugSeverity('critical')).toBe(true)
    expect(isBugSeverity('urgent')).toBe(false)
  })

  it('isBugStatus accepts valid values', () => {
    expect(isBugStatus('open')).toBe(true)
    expect(isBugStatus('closed')).toBe(false)
  })
})

describe('assert functions', () => {
  it('assertNodeStatus returns valid value', () => {
    expect(assertNodeStatus('draft')).toBe('draft')
  })

  it('assertNodeStatus throws on invalid value', () => {
    expect(() => assertNodeStatus('invalid')).toThrow(TypeError)
    expect(() => assertNodeStatus('invalid')).toThrow('Invalid status')
  })

  it('assertGraphType returns valid value', () => {
    expect(assertGraphType('online')).toBe('online')
  })

  it('assertGraphType throws on invalid value', () => {
    expect(() => assertGraphType('staging')).toThrow(TypeError)
  })

  it('assertBugSeverity includes field name in error', () => {
    expect(() => assertBugSeverity('urgent', 'severity')).toThrow('Invalid severity')
  })

  it('assertBugStatus throws on invalid value', () => {
    expect(() => assertBugStatus('closed')).toThrow(TypeError)
  })
})