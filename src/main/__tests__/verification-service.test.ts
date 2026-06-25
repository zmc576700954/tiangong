import { describe, it, expect } from 'vitest'
import { VerificationService } from '../agent/verification-service'
import type { ChatMessage, AgentOutput } from '@shared/types'

describe('VerificationService', () => {
  const service = new VerificationService()

  // ==================== buildVerificationPrompt ====================
  describe('buildVerificationPrompt', () => {
    it('构建包含验收标准的 prompt', () => {
      const messages: ChatMessage[] = [
        { id: '1', role: 'agent', content: '实现了登录功能', timestamp: 1, status: 'success' },
      ]
      const fileChanges: AgentOutput[] = [
        { type: 'file_change', data: 'changed', timestamp: 1, filePath: 'src/auth.ts', changeType: 'modify' },
      ]

      const prompt = service.buildVerificationPrompt(
        'node1',
        ['支持邮箱登录', '密码加密存储'],
        messages,
        fileChanges,
      )

      expect(prompt).toContain('1. 支持邮箱登录')
      expect(prompt).toContain('2. 密码加密存储')
      expect(prompt).toContain('src/auth.ts')
      expect(prompt).toContain('CRITERION_N: PASS or FAIL')
      expect(prompt).toContain('JUSTIFICATION_N')
    })

    it('过滤非 agent 消息', () => {
      const messages: ChatMessage[] = [
        { id: '1', role: 'user', content: '请实现登录', timestamp: 1, status: 'success' },
        { id: '2', role: 'agent', content: '已完成登录实现', timestamp: 2, status: 'success' },
        { id: '3', role: 'system', content: '系统消息', timestamp: 3, status: 'success' },
      ]

      const prompt = service.buildVerificationPrompt('n1', ['c1'], messages, [])
      expect(prompt).toContain('已完成登录实现')
      expect(prompt).not.toContain('请实现登录')
      expect(prompt).not.toContain('系统消息')
    })

    it('去重文件路径', () => {
      const fileChanges: AgentOutput[] = [
        { type: 'file_change', data: 'a', timestamp: 1, filePath: 'src/a.ts', changeType: 'add' },
        { type: 'file_change', data: 'a', timestamp: 2, filePath: 'src/a.ts', changeType: 'modify' },
        { type: 'file_change', data: 'b', timestamp: 3, filePath: 'src/b.ts', changeType: 'modify' },
      ]

      const prompt = service.buildVerificationPrompt('n1', ['c1'], [], fileChanges)
      const matches = prompt.match(/src\/a\.ts/g)
      expect(matches).toHaveLength(1)
      expect(prompt).toContain('src/b.ts')
    })

    it('过滤无 filePath 的输出', () => {
      const fileChanges: AgentOutput[] = [
        { type: 'stdout', data: 'output', timestamp: 1 },
        { type: 'file_change', data: 'change', timestamp: 2, filePath: 'src/x.ts' },
      ]

      const prompt = service.buildVerificationPrompt('n1', ['c1'], [], fileChanges)
      expect(prompt).toContain('src/x.ts')
    })

    it('agent 消息超长时截断到 3000 字符', () => {
      const longContent = 'A'.repeat(5000)
      const messages: ChatMessage[] = [
        { id: '1', role: 'agent', content: longContent, timestamp: 1, status: 'success' },
      ]

      const prompt = service.buildVerificationPrompt('n1', ['c1'], messages, [])
      // 验证不会包含完整 5000 字符
      expect(prompt.length).toBeLessThan(6000)
    })
  })

  // ==================== parseVerificationResponse ====================
  describe('parseVerificationResponse', () => {
    it('正确解析 PASS/FAIL 结果', () => {
      const response = `CRITERION_1: PASS
JUSTIFICATION_1: 邮箱登录已正确实现
CRITERION_2: FAIL
JUSTIFICATION_2: 密码未加密，使用明文存储`

      const results = service.parseVerificationResponse(response, ['支持邮箱登录', '密码加密存储'])
      expect(results).toHaveLength(2)
      expect(results[0].passed).toBe(true)
      expect(results[0].criterion).toBe('支持邮箱登录')
      expect(results[0].justification).toContain('邮箱登录已正确实现')
      expect(results[1].passed).toBe(false)
      expect(results[1].justification).toContain('密码未加密')
    })

    it('大小写不敏感', () => {
      const response = `criterion_1: pass
justification_1: OK`
      const results = service.parseVerificationResponse(response, ['c1'])
      expect(results[0].passed).toBe(true)
    })

    it('缺失的 criterion → passed=false', () => {
      const response = 'No results here'
      const results = service.parseVerificationResponse(response, ['c1', 'c2'])
      expect(results).toHaveLength(2)
      expect(results[0].passed).toBe(false)
      expect(results[0].justification).toBe('No justification provided')
      expect(results[1].passed).toBe(false)
    })

    it('多行 justification 包含空行也能正确捕获', () => {
      const response = `CRITERION_1: PASS
JUSTIFICATION_1: 邮箱登录已正确实现
并且包含第二行说明

CRITERION_2: FAIL
JUSTIFICATION_2: 密码未加密
使用明文存储`

      const results = service.parseVerificationResponse(response, ['支持邮箱登录', '密码加密存储'])
      expect(results).toHaveLength(2)
      expect(results[0].passed).toBe(true)
      expect(results[0].justification).toContain('第二行说明')
      expect(results[1].passed).toBe(false)
      expect(results[1].justification).toContain('使用明文存储')
    })

    it('部分匹配 → 缺失的默认 false', () => {
      const response = `CRITERION_1: PASS
JUSTIFICATION_1: Done`
      const results = service.parseVerificationResponse(response, ['c1', 'c2', 'c3'])
      expect(results[0].passed).toBe(true)
      expect(results[1].passed).toBe(false)
      expect(results[2].passed).toBe(false)
    })

    it('空验收标准数组 → 空结果', () => {
      const results = service.parseVerificationResponse('CRITERION_1: PASS', [])
      expect(results).toEqual([])
    })

    it('多余 criterion 不影响结果', () => {
      const response = `CRITERION_1: PASS
JUSTIFICATION_1: OK
CRITERION_99: FAIL
JUSTIFICATION_99: Irrelevant`
      const results = service.parseVerificationResponse(response, ['c1'])
      expect(results).toHaveLength(1)
      expect(results[0].passed).toBe(true)
    })
  })

  // ==================== buildRetryPrompt ====================
  describe('buildRetryPrompt', () => {
    it('构建包含失败信息的 prompt', () => {
      const failed = [
        { criterion: '密码加密', passed: false, justification: '密码使用明文存储' },
        { criterion: '输入验证', passed: false, justification: '未对输入进行校验' },
      ]

      const prompt = service.buildRetryPrompt(failed)
      expect(prompt).toContain('1. 密码加密')
      expect(prompt).toContain('Issue: 密码使用明文存储')
      expect(prompt).toContain('2. 输入验证')
      expect(prompt).toContain('Issue: 未对输入进行校验')
      expect(prompt).toContain('Please address each issue')
    })

    it('空失败列表 → 基本 prompt', () => {
      const prompt = service.buildRetryPrompt([])
      expect(prompt).toContain('not met')
    })
  })
})
