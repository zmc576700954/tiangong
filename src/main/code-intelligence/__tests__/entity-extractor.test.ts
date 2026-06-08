/**
 * EntityExtractor 单元测试
 */

import { describe, it, expect } from 'vitest'
import { EntityExtractor } from '../entity-extractor'

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
})
