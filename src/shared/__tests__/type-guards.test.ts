import { describe, it, expect } from 'vitest'
import {
  isNodeStatus, isNodeType, isGraphType, isEdgeType, isBugSeverity, isBugStatus,
  assertNodeStatus, assertGraphType, assertBugSeverity, assertBugStatus,
  isContextRefArray, isBusinessRuleArray, isToolCallBlockArray, isMessageError,
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
describe('JSON 列的元素级守卫', () => {
  it('isContextRefArray 逐元素校验 —— [null] 不能通过', () => {
    // 渲染层对 contextRefs 做 .map 并访问元素字段，元素为 null 同样崩
    expect(isContextRefArray([{ type: 'file', id: 'f1', label: 'auth.ts' }])).toBe(true)
    expect(isContextRefArray([null])).toBe(false)
    expect(isContextRefArray([{ type: 'file', id: 'f1' }])).toBe(false)
    expect(isContextRefArray([{ type: 'file', id: 'f1', label: 42 }])).toBe(false)
    expect(isContextRefArray('not-an-array')).toBe(false)
  })

  it('isBusinessRuleArray 逐元素校验 —— 缺 title 不能通过', () => {
    const rule = { id: 'r1', title: 'T', description: 'd', condition: 'c', action: 'a' }
    expect(isBusinessRuleArray([rule])).toBe(true)
    expect(isBusinessRuleArray([{ ...rule, title: undefined }])).toBe(false)
    expect(isBusinessRuleArray([null])).toBe(false)
  })

  it('isToolCallBlockArray 逐元素校验 —— content 必须是字符串', () => {
    const block = { type: 'file_edit', content: 'x', status: 'done' }
    expect(isToolCallBlockArray([block])).toBe(true)
    expect(isToolCallBlockArray([{ ...block, content: 1 }])).toBe(false)
    expect(isToolCallBlockArray([null])).toBe(false)
  })

  it('isMessageError 要求 code 与 message 都是字符串', () => {
    expect(isMessageError({ code: 'AGENT_CRASH', message: 'boom' })).toBe(true)
    expect(isMessageError({ code: 'AGENT_CRASH' })).toBe(false)
    expect(isMessageError({ code: 'AGENT_CRASH', message: 5 })).toBe(false)
    expect(isMessageError(null)).toBe(false)
  })
})
