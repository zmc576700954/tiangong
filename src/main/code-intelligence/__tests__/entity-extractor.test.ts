/**
 * EntityExtractor 单元测试
 */

import { describe, it, expect } from 'vitest'
import { EntityExtractor, computeLineInfo } from '../entity-extractor'

describe('computeLineInfo', () => {
  it('should compute line/column for single-line text', () => {
    const text = 'hello world'
    const info = computeLineInfo(text, 0, 5)
    expect(info).toEqual({ line: 1, endLine: 1, column: 0, endColumn: 5 })
  })

  it('should compute line/column for entity in the middle of a single line', () => {
    const text = 'aaa bbb ccc'
    const info = computeLineInfo(text, 4, 7) // "bbb"
    expect(info).toEqual({ line: 1, endLine: 1, column: 4, endColumn: 7 })
  })

  it('should compute line/column for entity on the second line', () => {
    const text = 'first line\nsecond line\nthird line'
    const info = computeLineInfo(text, 11, 17) // "second"
    expect(info).toEqual({ line: 2, endLine: 2, column: 0, endColumn: 6 })
  })

  it('should compute line/column for multi-line entity', () => {
    const text = 'line1\nline2\nline3'
    // "e1\nl" spans from index 3 (on line 1) to index 7 (on line 2)
    const info = computeLineInfo(text, 3, 7)
    expect(info).toEqual({ line: 1, endLine: 2, column: 3, endColumn: 1 })
  })

  it('should compute line/column for entity at the very end of text', () => {
    const text = 'abc\ndef'
    const info = computeLineInfo(text, 4, 7) // "def"
    expect(info).toEqual({ line: 2, endLine: 2, column: 0, endColumn: 3 })
  })

  it('should handle entity at start of text', () => {
    const text = 'start here'
    const info = computeLineInfo(text, 0, 5) // "start"
    expect(info).toEqual({ line: 1, endLine: 1, column: 0, endColumn: 5 })
  })
})

describe('EntityExtractor', () => {
  const extractor = new EntityExtractor()

  it('should extract class names from Chinese requirement', () => {
    const input = '请给 UserService 添加一个根据 email 查找用户的方法'
    const result = extractor.extract(input)

    expect(result.intent).toBe('implement')
    expect(result.entities.some((e) => e.name === 'UserService' && e.type === 'class')).toBe(true)
  })

  it('should extract file paths', () => {
    const input = '修改 src/user/controller.ts 中的 login 方法'
    const result = extractor.extract(input)

    const fileEntity = result.entities.find((e) => e.type === 'file')
    expect(fileEntity?.name).toBe('src/user/controller.ts')
  })

  it('should detect fix intent', () => {
    const input = '修复 AuthService 中的内存泄漏问题'
    const result = extractor.extract(input)
    expect(result.intent).toBe('fix')
    expect(result.entities.some((e) => e.name === 'AuthService')).toBe(true)
  })

  it('should detect refactor intent', () => {
    const input = '重构 UserController，把验证逻辑提取到中间件中'
    const result = extractor.extract(input)
    expect(result.intent).toBe('refactor')
  })

  it('should extract method references in Chinese pattern', () => {
    const input = '实现 UserService 的 createUser 方法'
    const result = extractor.extract(input)

    const method = result.entities.find((e) => e.name === 'createUser')
    expect(method?.type).toBe('method')
    expect(method?.confidence).toBeGreaterThan(0.8)
  })

  it('should handle English requirements', () => {
    const input = 'Add logging to the UserController.login method'
    const result = extractor.extract(input)

    expect(result.intent).toBe('implement')
    expect(result.entities.some((e) => e.name === 'UserController' && e.type === 'class')).toBe(true)
    expect(result.entities.some((e) => e.name === 'login' && e.type === 'method')).toBe(true)
  })

  it('should populate line/column info for single-line entities', () => {
    const input = '请给 UserService 添加方法'
    const result = extractor.extract(input)
    const entity = result.entities.find((e) => e.name === 'UserService')
    expect(entity).toBeDefined()
    expect(entity!.line).toBe(1)
    expect(entity!.endLine).toBe(1)
    expect(entity!.column).toBe(input.indexOf('UserService'))
    expect(entity!.endColumn).toBe(input.indexOf('UserService') + 'UserService'.length)
  })

  it('should populate line/column info for multi-line input', () => {
    const input = '第一行\n请给 UserService 添加方法\n第三行'
    const result = extractor.extract(input)
    const entity = result.entities.find((e) => e.name === 'UserService')
    expect(entity).toBeDefined()
    expect(entity!.line).toBe(2)
    expect(entity!.endLine).toBe(2)
    // "UserService" starts at index 4 on line 2 (after "请给 ")
    const line2Start = input.indexOf('\n') + 1
    const entityStart = input.indexOf('UserService')
    expect(entity!.column).toBe(entityStart - line2Start)
    expect(entity!.endColumn).toBe(entityStart - line2Start + 'UserService'.length)
  })
})
