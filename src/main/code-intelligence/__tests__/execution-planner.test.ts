/**
 * ExecutionPlanner 单元测试
 */

import { describe, it, expect } from 'vitest'
import { ExecutionPlanner } from '../execution-planner'

describe('ExecutionPlanner', () => {
  const planner = new ExecutionPlanner()

  it('should plan implementation with class and method', () => {
    const plan = planner.generatePlan('给 UserService 添加 createUser 方法')

    expect(plan.intent).toBe('implement')
    expect(plan.steps.some((s) => s.action === 'read' && s.target === 'UserService')).toBe(true)
    expect(plan.steps.some((s) => s.action === 'modify' && s.target.includes('createUser'))).toBe(true)
    expect(plan.steps.some((s) => s.action === 'verify')).toBe(true)
  })

  it('should plan fix with test step', () => {
    const plan = planner.generatePlan('修复 AuthService 中的 token 过期问题')

    expect(plan.intent).toBe('fix')
    expect(plan.steps.some((s) => s.action === 'read')).toBe(true)
    expect(plan.steps.some((s) => s.action === 'modify')).toBe(true)
    expect(plan.steps.some((s) => s.action === 'test')).toBe(true)
  })

  it('should plan refactor', () => {
    const plan = planner.generatePlan('重构 UserController，提取验证逻辑')

    expect(plan.intent).toBe('refactor')
    expect(plan.steps.length).toBeGreaterThanOrEqual(2)
  })

  it('should estimate complexity based on steps', () => {
    const simple = planner.generatePlan('修复 bug')
    expect(['simple', 'moderate', 'complex']).toContain(simple.estimatedComplexity)
  })
})
