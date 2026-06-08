import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readMemory, writeMemory, addRefinement, updateDomains } from '../mindmap-agent/memory'

// Use vi.hoisted so the mocks are available when vi.mock factory runs (hoisted)
const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  default: mockFs,
  readFile: (...args: unknown[]) => mockFs.readFile(...args),
  writeFile: (...args: unknown[]) => mockFs.writeFile(...args),
  mkdir: (...args: unknown[]) => mockFs.mkdir(...args),
}))

describe('memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFs.mkdir.mockResolvedValue(undefined)
    mockFs.writeFile.mockResolvedValue(undefined)
  })

  // ==================== readMemory ====================
  describe('readMemory', () => {
    it('文件存在 → 解析并合并默认值', async () => {
      const existing = {
        projectId: 'p1',
        projectPath: '/project',
        businessDomains: ['用户管理'],
        architecturePattern: 'MVC',
        coreUserFlows: [],
        techConstraints: [],
        refinements: [],
        preferences: { granularity: 'fine', namingStyle: 'technical', maxModules: 8, avoidPatterns: [] },
        updatedAt: '2024-01-01',
      }
      mockFs.readFile.mockResolvedValue(JSON.stringify(existing))

      const memory = await readMemory('/project')
      expect(memory.projectId).toBe('p1')
      expect(memory.businessDomains).toEqual(['用户管理'])
      // preferences 合并默认值
      expect(memory.preferences.granularity).toBe('fine')
      expect(memory.preferences.namingStyle).toBe('technical')
    })

    it('文件不存在 → 返回默认值', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'))

      const memory = await readMemory('/project')
      expect(memory.projectPath).toBe('/project')
      expect(memory.businessDomains).toEqual([])
      expect(memory.preferences.granularity).toBe('medium')
      expect(memory.preferences.namingStyle).toBe('business')
      expect(memory.preferences.maxModules).toBe(6)
    })

    it('JSON 解析失败 → 返回默认值', async () => {
      mockFs.readFile.mockResolvedValue('invalid json{{{')

      const memory = await readMemory('/project')
      expect(memory.projectPath).toBe('/project')
      expect(memory.preferences.granularity).toBe('medium')
    })

    it('旧文件缺少新字段 → 默认值补全', async () => {
      const old = {
        projectId: 'p1',
        projectPath: '/project',
        businessDomains: [],
        architecturePattern: '',
        coreUserFlows: [],
        techConstraints: [],
        refinements: [],
        // preferences 缺少 avoidPatterns
        preferences: { granularity: 'medium', namingStyle: 'business', maxModules: 6 },
        updatedAt: '2024-01-01',
      }
      mockFs.readFile.mockResolvedValue(JSON.stringify(old))

      const memory = await readMemory('/project')
      expect(memory.preferences.avoidPatterns).toBeDefined()
      expect(memory.preferences.avoidPatterns.length).toBeGreaterThan(0)
    })
  })

  // ==================== writeMemory ====================
  describe('writeMemory', () => {
    it('创建目录并写入文件', async () => {
      const memory = {
        projectId: 'p1', projectPath: '/project',
        businessDomains: [], architecturePattern: '',
        coreUserFlows: [], techConstraints: [],
        refinements: [], preferences: { granularity: 'medium' as const, namingStyle: 'business' as const, maxModules: 6, avoidPatterns: [] },
        updatedAt: '',
      }

      await writeMemory('/project', memory)
      expect(mockFs.mkdir).toHaveBeenCalledWith(expect.stringContaining('.bizgraph'), { recursive: true })
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('memory.json'),
        expect.stringContaining('"projectId": "p1"'),
        'utf-8',
      )
    })

    it('更新 updatedAt 时间戳', async () => {
      const memory = {
        projectId: '', projectPath: '/p',
        businessDomains: [], architecturePattern: '',
        coreUserFlows: [], techConstraints: [],
        refinements: [], preferences: { granularity: 'medium' as const, namingStyle: 'business' as const, maxModules: 6, avoidPatterns: [] },
        updatedAt: 'old-time',
      }

      await writeMemory('/p', memory)
      expect(memory.updatedAt).not.toBe('old-time')
    })
  })

  // ==================== addRefinement ====================
  describe('addRefinement', () => {
    it('添加精炼记录', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'))

      const memory = await addRefinement('/project', {
        scope: 'module',
        targetId: 'm1',
        before: '旧名称',
        after: '新名称',
        reason: '改为更好的业务名称',
      })

      expect(memory.refinements).toHaveLength(1)
      expect(memory.refinements[0].scope).toBe('module')
      expect(memory.refinements[0].timestamp).toBeDefined()
      expect(mockFs.writeFile).toHaveBeenCalled()
    })

    it('从精炼历史学习命名偏好 (business)', async () => {
      const existingRefinements = [
        { scope: 'module' as const, targetId: 'm1', before: 'Handler', after: '用户管理服务', reason: '命名改为业务名称', timestamp: '2024-01-01' },
        { scope: 'module' as const, targetId: 'm2', before: 'Controller', after: '订单系统', reason: '名称不够业务化', timestamp: '2024-01-02' },
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        projectId: '', projectPath: '/p',
        businessDomains: [], architecturePattern: '',
        coreUserFlows: [], techConstraints: [],
        refinements: existingRefinements,
        preferences: { granularity: 'medium', namingStyle: 'mixed', maxModules: 6, avoidPatterns: [] },
        updatedAt: '2024-01-01',
      }))

      const memory = await addRefinement('/p', {
        scope: 'node', targetId: 'n1', before: 'Service', after: '支付流程', reason: '命名改为业务名称',
      })

      expect(memory.preferences.namingStyle).toBe('business')
    })

    it('从精炼历史学习粒度偏好 (fine)', async () => {
      const existingRefinements = [
        { scope: 'module' as const, targetId: 'm1', before: '大模块', after: '子模块A', reason: '需要拆分', timestamp: '2024-01-01' },
        { scope: 'module' as const, targetId: 'm2', before: '混合模块', after: '子模块B', reason: '拆分更细', timestamp: '2024-01-02' },
      ]
      mockFs.readFile.mockResolvedValue(JSON.stringify({
        projectId: '', projectPath: '/p',
        businessDomains: [], architecturePattern: '',
        coreUserFlows: [], techConstraints: [],
        refinements: existingRefinements,
        preferences: { granularity: 'medium', namingStyle: 'business', maxModules: 6, avoidPatterns: [] },
        updatedAt: '2024-01-01',
      }))

      const memory = await addRefinement('/p', {
        scope: 'module', targetId: 'm3', before: 'X', after: 'Y', reason: '拆分为更小模块',
      })

      expect(memory.preferences.granularity).toBe('fine')
      expect(memory.preferences.maxModules).toBe(7) // 6 + 1
    })
  })

  // ==================== updateDomains ====================
  describe('updateDomains', () => {
    it('更新业务域和架构信息', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'))

      await updateDomains('/project', ['用户管理', '订单系统'], 'MVC', ['注册→下单'], ['无ORM'])

      expect(mockFs.writeFile).toHaveBeenCalled()
      const writtenJson = mockFs.writeFile.mock.calls[0][1]
      const written = JSON.parse(writtenJson)
      expect(written.businessDomains).toEqual(['用户管理', '订单系统'])
      expect(written.architecturePattern).toBe('MVC')
      expect(written.coreUserFlows).toEqual(['注册→下单'])
      expect(written.techConstraints).toEqual(['无ORM'])
    })
  })
})

// ==================== Semaphore (from types.ts) ====================
describe('Semaphore', () => {
  // Semaphore is in project-scanner/types.ts
  it('控制并发数', async () => {
    const { Semaphore } = await import('../project-scanner/types')
    const sem = new Semaphore(2)

    let running = 0
    let maxRunning = 0

    async function task() {
      await sem.acquire()
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise(r => setTimeout(r, 50))
      running--
      sem.release()
    }

    await Promise.all([task(), task(), task(), task()])
    expect(maxRunning).toBeLessThanOrEqual(2)
  })

  it('acquire/release 基本流程', async () => {
    const { Semaphore } = await import('../project-scanner/types')
    const sem = new Semaphore(1)

    await sem.acquire()
    // 第二个 acquire 应该等待
    let resolved = false
    const p = sem.acquire().then(() => { resolved = true })

    // 还没释放，不应该完成
    await new Promise(r => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // 释放后应该完成
    sem.release()
    await p
    expect(resolved).toBe(true)
  })
})
