import { describe, it, expect } from 'vitest'
import { finalCheck } from '../gates/final-check'

describe('finalCheck', () => {
  it('passes for well-formed prompt', () => {
    const result = finalCheck(
      '实现登录功能，业务规则：验证用户凭证。验收标准：成功登录。src/auth.ts',
      '登录功能',
      'feature',
    )
    expect(result.passed).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0.5)
    expect(result.issues.length).toBe(0)
  })

  it('fails when missing business rules', () => {
    const result = finalCheck(
      '实现登录功能，src/auth.ts',
      '登录功能',
      'feature',
    )
    expect(result.issues).toContain('缺少业务规则或验收标准')
  })

  it('fails when missing scope constraints', () => {
    const result = finalCheck(
      '实现登录功能，业务规则：验证用户凭证',
      '登录功能',
      'feature',
    )
    expect(result.issues).toContain('缺少明确的文件范围约束')
  })

  it('fails when missing task description for feature', () => {
    const result = finalCheck(
      '用户认证模块，业务规则：验证。验收标准：完成。src/auth.ts',
      '认证模块',
      'feature',
    )
    expect(result.issues).toContain('缺少明确的任务描述')
  })

  it('detects noise information', () => {
    const result = finalCheck(
      '实现登录功能，npm run build，node_modules，业务规则：验证。验收标准：完成。src/auth.ts',
      '登录功能',
      'feature',
    )
    expect(result.issues.some((i) => i.includes('噪音信息'))).toBe(true)
  })

  it('checks node title appears in prompt', () => {
    const result = finalCheck(
      '实现功能，业务规则：验证。验收标准：完成。src/auth.ts',
      '登录功能',
      'feature',
    )
    expect(result.issues.some((i) => i.includes('登录功能'))).toBe(true)
  })

  it('passes for bugfix task type', () => {
    const result = finalCheck(
      '修复登录页面崩溃问题，bug fix error。业务规则：处理异常。验收标准：不再崩溃。src/auth.ts',
      '登录崩溃',
      'bugfix',
    )
    expect(result.passed).toBe(true)
  })

  it('passes for refactor task type', () => {
    const result = finalCheck(
      '重构认证模块，refactor improve。业务规则：保持API不变。验收标准：所有测试通过。src/auth.ts',
      '认证重构',
      'refactor',
    )
    expect(result.passed).toBe(true)
  })

  it('score does not go below 0', () => {
    const result = finalCheck('nothing', 'title', 'feature')
    expect(result.score).toBeGreaterThanOrEqual(0)
  })
})
