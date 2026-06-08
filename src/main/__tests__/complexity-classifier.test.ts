import { describe, it, expect } from 'vitest'
import { classifyComplexity } from '../mindmap-agent/complexity-classifier'
import type { ClassificationResult } from '../mindmap-agent/complexity-classifier'

describe('classifyComplexity', () => {
  const domains = ['用户管理', '订单系统', '支付', '库存']

  // ==================== Global 级别 ====================
  describe('global 级别分类', () => {
    it('初始化项目 → global', () => {
      const result = classifyComplexity('初始化项目思维导图', domains)
      expect(result.complexity).toBe('global')
      expect(result.strategy).toBe('global')
      expect(result.matchedDomains).toEqual([])
    })

    it('生成项目全部思维导图 → global', () => {
      const result = classifyComplexity('生成项目全部思维导图', domains)
      expect(result.complexity).toBe('global')
    })

    it('扫描整体 → global', () => {
      const result = classifyComplexity('扫描整体项目结构', domains)
      expect(result.complexity).toBe('global')
    })

    it('重新生成导图 → global', () => {
      const result = classifyComplexity('重新生成思维导图', domains)
      expect(result.complexity).toBe('global')
    })

    it('generate full → global (英文)', () => {
      const result = classifyComplexity('generate full mindmap', domains)
      expect(result.complexity).toBe('global')
    })

    it('regenerate → global (英文)', () => {
      const result = classifyComplexity('regenerate everything', domains)
      expect(result.complexity).toBe('global')
    })
  })

  // ==================== Simple 级别 ====================
  describe('simple 级别分类', () => {
    it('查看单个节点 → simple', () => {
      const result = classifyComplexity('查看单个节点详情', domains)
      expect(result.complexity).toBe('simple')
      expect(result.strategy).toBe('direct')
    })

    it('显示单个功能 → simple', () => {
      const result = classifyComplexity('显示单个功能详情', domains)
      expect(result.complexity).toBe('simple')
    })

    it('enrich节点 → simple', () => {
      const result = classifyComplexity('enrich 节点内容', domains)
      expect(result.complexity).toBe('simple')
    })

    it('深化单个节点 → simple', () => {
      const result = classifyComplexity('深化补充节点信息', domains)
      expect(result.complexity).toBe('simple')
    })
  })

  // ==================== Complex 级别 ====================
  describe('complex 级别分类', () => {
    it('多域匹配 → complex', () => {
      const result = classifyComplexity('分析用户管理和订单系统的交互', domains)
      expect(result.complexity).toBe('complex')
      expect(result.strategy).toBe('drift')
      expect(result.matchedDomains.length).toBeGreaterThanOrEqual(2)
    })

    it('包含"联动"关键词 → complex', () => {
      const result = classifyComplexity('用户管理模块联动', domains)
      expect(result.complexity).toBe('complex')
    })

    it('包含"依赖"关键词 → complex', () => {
      const result = classifyComplexity('分析订单系统的依赖关系', domains)
      expect(result.complexity).toBe('complex')
    })

    it('包含"性能/安全/架构"关键词 → complex', () => {
      const result = classifyComplexity('分析系统性能瓶颈', domains)
      expect(result.complexity).toBe('complex')
    })

    it('包含"优化"但无"单个" → complex', () => {
      const result = classifyComplexity('优化系统整体架构', domains)
      expect(result.complexity).toBe('complex')
    })

    it('模糊长需求无匹配域 → complex', () => {
      const result = classifyComplexity('需要一个能够处理大量数据的方案', [])
      expect(result.complexity).toBe('complex')
      expect(result.reason).toBe('需求模糊或涉及全局')
    })
  })

  // ==================== Moderate 级别 ====================
  describe('moderate 级别分类', () => {
    it('单域匹配 → moderate', () => {
      const result = classifyComplexity('分析用户管理模块', domains)
      expect(result.complexity).toBe('moderate')
      expect(result.strategy).toBe('local')
      expect(result.matchedDomains).toEqual(['用户管理'])
    })

    it('无任何匹配短需求 → moderate (默认)', () => {
      const result = classifyComplexity('你好', domains)
      expect(result.complexity).toBe('moderate')
      expect(result.reason).toBe('默认分类')
    })
  })

  // ==================== 边界条件 ====================
  describe('边界条件', () => {
    it('空字符串 → moderate (默认)', () => {
      const result = classifyComplexity('', domains)
      expect(result.complexity).toBe('moderate')
    })

    it('空可用域列表 → 正常分类', () => {
      const result = classifyComplexity('初始化项目', [])
      expect(result.complexity).toBe('global')
    })

    it('域匹配大小写不敏感', () => {
      const result = classifyComplexity('分析USER管理的功能', ['User管理'])
      expect(result.matchedDomains).toContain('User管理')
    })

    it('优化但包含"单个"不触发 complex', () => {
      const result = classifyComplexity('优化单个模块', domains)
      // "单个" 在 complex indicator 中被排除
      expect(result.complexity).not.toBe('global')
    })

    it('返回值结构完整', () => {
      const result: ClassificationResult = classifyComplexity('test', domains)
      expect(result).toHaveProperty('complexity')
      expect(result).toHaveProperty('reason')
      expect(result).toHaveProperty('matchedDomains')
      expect(result).toHaveProperty('strategy')
      expect(['simple', 'moderate', 'complex', 'global']).toContain(result.complexity)
      expect(['direct', 'local', 'drift', 'global']).toContain(result.strategy)
    })
  })
})
