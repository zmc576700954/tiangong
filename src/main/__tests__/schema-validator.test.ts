import { describe, it, expect } from 'vitest'
import { validateModules, validateEnrichment } from '../mindmap-agent/schema-validator'

describe('validateModules', () => {
  // ==================== 正常输入 ====================
  describe('正常输入', () => {
    it('有效的模块数组 → 正确解析', () => {
      const raw = [
        {
          name: '用户管理',
          description: '管理用户信息',
          processes: [
            {
              name: '注册流程',
              description: '用户注册',
              features: [
                { name: '邮箱注册', description: '通过邮箱注册', type: 'feature' },
              ],
            },
          ],
        },
      ]
      const result = validateModules(raw)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('用户管理')
      expect(result[0].processes).toHaveLength(1)
      expect(result[0].processes[0].features).toHaveLength(1)
    })

    it('包裹在 { modules: [...] } 中 → 正确解析', () => {
      const raw = {
        modules: [
          {
            name: '订单系统',
            description: '处理订单',
            processes: [
              { name: '下单', description: '创建订单', features: [{ name: '创建订单', description: 'desc', type: 'feature' }] },
            ],
          },
        ],
      }
      const result = validateModules(raw)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('订单系统')
    })
  })

  // ==================== 容错处理 ====================
  describe('容错处理', () => {
    it('非数组非对象 → 空数组', () => {
      expect(validateModules(null)).toEqual([])
      expect(validateModules(undefined)).toEqual([])
      expect(validateModules('string')).toEqual([])
      expect(validateModules(42)).toEqual([])
    })

    it('空数组 → 空数组', () => {
      expect(validateModules([])).toEqual([])
    })

    it('null 模块 → 跳过', () => {
      const result = validateModules([null, undefined, 42])
      expect(result).toEqual([])
    })

    it('缺少 name 的模块 → 跳过', () => {
      const result = validateModules([
        { description: 'desc', processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }] },
      ])
      expect(result).toEqual([])
    })

    it('name 为空字符串的模块 → 跳过', () => {
      const result = validateModules([
        { name: '  ', description: 'desc', processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }] },
      ])
      expect(result).toEqual([])
    })

    it('没有有效流程的模块 → 跳过', () => {
      const result = validateModules([
        { name: '模块A', description: 'desc', processes: [] },
      ])
      expect(result).toEqual([])
    })
  })

  // ==================== 噪音过滤 ====================
  describe('噪音过滤', () => {
    it('npm scripts 名称 → 过滤', () => {
      const result = validateModules([
        { name: 'npm run dev', description: 'desc', processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }] },
      ])
      expect(result).toEqual([])
    })

    it('工具名称作为模块名 → 过滤', () => {
      const result = validateModules([
        { name: 'eslint', description: 'desc', processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }] },
      ])
      expect(result).toEqual([])
    })

    it('噪音功能名 → 过滤', () => {
      const result = validateModules([
        {
          name: '有效模块',
          description: 'desc',
          processes: [{
            name: '有效流程',
            description: 'desc',
            features: [
              { name: 'node_modules', description: 'desc', type: 'feature' },
              { name: 'valid feature', description: 'desc', type: 'feature' },
            ],
          }],
        },
      ])
      expect(result[0].processes[0].features).toHaveLength(1)
      expect(result[0].processes[0].features[0].name).toBe('valid feature')
    })

    it('全是噪音功能的流程 → 过滤', () => {
      const result = validateModules([
        {
          name: '有效模块',
          description: 'desc',
          processes: [{
            name: '噪音流程',
            description: 'desc',
            features: [
              { name: 'node_modules', description: 'desc', type: 'feature' },
              { name: 'vitest', description: 'desc', type: 'feature' },
            ],
          }],
        },
      ])
      expect(result).toEqual([])
    })
  })

  // ==================== 截断限制 ====================
  describe('截断限制', () => {
    it('超长 name → 截断到 50 字符', () => {
      const longName = 'A'.repeat(60)
      const result = validateModules([
        { name: longName, description: 'desc', processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }] },
      ])
      expect(result[0].name.length).toBeLessThanOrEqual(53) // 50 + '...'
      expect(result[0].name).toContain('...')
    })

    it('超长 description → 截断到 200 字符', () => {
      const longDesc = 'B'.repeat(210)
      const result = validateModules([
        { name: 'Module', description: longDesc, processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }] },
      ])
      expect(result[0].description.length).toBeLessThanOrEqual(203) // 200 + '...'
    })

    it('模块数限制 → 最多 8 个', () => {
      const modules = Array.from({ length: 12 }, (_, i) => ({
        name: `Module${i}`,
        description: 'desc',
        processes: [{ name: 'p1', description: 'd', features: [{ name: 'f1', description: 'd', type: 'feature' }] }],
      }))
      const result = validateModules(modules)
      expect(result).toHaveLength(8)
    })

    it('流程数限制 → 最多 6 个', () => {
      const processes = Array.from({ length: 10 }, (_, i) => ({
        name: `Process${i}`,
        description: 'desc',
        features: [{ name: 'f1', description: 'd', type: 'feature' }],
      }))
      const result = validateModules([
        { name: 'Module', description: 'desc', processes },
      ])
      expect(result[0].processes).toHaveLength(6)
    })

    it('功能数限制 → 最多 8 个', () => {
      const features = Array.from({ length: 12 }, (_, i) => ({
        name: `Feature${i}`,
        description: 'desc',
        type: 'feature',
      }))
      const result = validateModules([
        { name: 'Module', description: 'desc', processes: [{ name: 'p1', description: 'd', features }] },
      ])
      expect(result[0].processes[0].features).toHaveLength(8)
    })
  })

  // ==================== 类型修正 ====================
  describe('类型修正', () => {
    it('feature type 非 bug → 默认 feature', () => {
      const result = validateModules([
        { name: 'M', description: 'd', processes: [{ name: 'p', description: 'd', features: [{ name: 'f', description: 'd', type: 'unknown' }] }] },
      ])
      expect(result[0].processes[0].features[0].type).toBe('feature')
    })

    it('feature type 为 bug → 保留 bug', () => {
      const result = validateModules([
        { name: 'M', description: 'd', processes: [{ name: 'p', description: 'd', features: [{ name: 'f', description: 'd', type: 'bug' }] }] },
      ])
      expect(result[0].processes[0].features[0].type).toBe('bug')
    })
  })
})

describe('validateEnrichment', () => {
  describe('正常输入', () => {
    it('有效 enrichment → 正确解析', () => {
      const raw = {
        description: '用户登录功能',
        acceptanceCriteria: ['支持邮箱登录', '支持手机登录'],
        businessRules: [
          { id: 'r1', title: '密码强度', description: 'desc', condition: '注册时', action: '检查密码' },
        ],
        relatedFiles: ['src/auth/login.ts'],
        implementationHints: ['使用 JWT'],
        codeSignatures: ['function login()'],
      }
      const result = validateEnrichment(raw)
      expect(result).not.toBeNull()
      expect(result!.description).toBe('用户登录功能')
      expect(result!.acceptanceCriteria).toHaveLength(2)
      expect(result!.businessRules).toHaveLength(1)
      expect(result!.relatedFiles).toHaveLength(1)
    })
  })

  describe('容错处理', () => {
    it('null → null', () => {
      expect(validateEnrichment(null)).toBeNull()
    })

    it('非对象 → null', () => {
      expect(validateEnrichment('string')).toBeNull()
      expect(validateEnrichment(42)).toBeNull()
    })

    it('缺少 description → null', () => {
      expect(validateEnrichment({ acceptanceCriteria: ['test'] })).toBeNull()
    })

    it('空 description → null', () => {
      expect(validateEnrichment({ description: '   ' })).toBeNull()
    })

    it('缺失数组字段 → 空数组', () => {
      const result = validateEnrichment({ description: 'Valid desc' })
      expect(result).not.toBeNull()
      expect(result!.acceptanceCriteria).toEqual([])
      expect(result!.businessRules).toEqual([])
      expect(result!.relatedFiles).toEqual([])
      expect(result!.implementationHints).toEqual([])
      expect(result!.codeSignatures).toEqual([])
    })

    it('business rule 缺少 title/condition/action → 过滤', () => {
      const result = validateEnrichment({
        description: 'desc',
        businessRules: [
          { id: 'r1', description: 'missing title/condition/action' },
          { id: 'r2', title: 'Rule2', description: 'd', condition: 'c', action: 'a' },
        ],
      })
      expect(result!.businessRules).toHaveLength(1)
      expect(result!.businessRules[0].title).toBe('Rule2')
    })
  })

  describe('截断限制', () => {
    it('acceptanceCriteria 限制 10 条', () => {
      const result = validateEnrichment({
        description: 'desc',
        acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `criterion ${i}`),
      })
      expect(result!.acceptanceCriteria).toHaveLength(10)
    })

    it('relatedFiles 限制 20 个', () => {
      const result = validateEnrichment({
        description: 'desc',
        relatedFiles: Array.from({ length: 25 }, (_, i) => `file${i}.ts`),
      })
      expect(result!.relatedFiles).toHaveLength(20)
    })
  })
})
