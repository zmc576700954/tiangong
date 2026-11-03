import { describe, it, expect } from 'vitest'
import { computeScope } from '../scope'

/**
 * 会话文件范围的计算。
 *
 * 这一段曾经出过三个 bug：
 * - 显示集合 ≠ 发送集合（面板说「只读」而会话可写）
 * - 存 / 显示 / 删除三种形态不一致 → 删除静默失效（「我关了它，它又自己开了」）
 * - 项目级默认与本次会话的项重复 → 「可修改 N 个文件」计数翻倍
 *
 * 所以断言的是**语义**：显示与发送必须是同一个集合。
 */

const PROJ = '/work/proj'

describe('computeScope — 范围为空即只读', () => {
  it('三个来源都空 → 只读', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: null,
      sessionScope: [],
      referencedFiles: [],
    })
    expect(r.relativeFiles).toEqual([])
    expect(r.readonly).toBe(true)
  })

  it('任一来源有内容 → 可写', () => {
    const base = { projectPath: PROJ, projectDefaults: null, sessionScope: [], referencedFiles: [] }
    expect(computeScope({ ...base, sessionScope: ['a.ts'] }).readonly).toBe(false)
    expect(
      computeScope({ ...base, projectDefaults: { allowedFiles: ['a.ts'] } }).readonly,
    ).toBe(false)
    expect(
      computeScope({ ...base, referencedFiles: ['/work/proj/a.ts'] }).readonly,
    ).toBe(false)
  })
})

describe('computeScope — 三个来源都要算进来', () => {
  it('@ 引用文件必须算进来（它们会进 allowedFiles，不显示的话面板会谎称只读）', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: null,
      sessionScope: [],
      referencedFiles: ['/work/proj/src/a.ts'],
    })
    expect(r.relativeFiles).toEqual(['src/a.ts'])
    expect(r.readonly).toBe(false)
  })

  it('三个来源合并，且去重', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: { allowedFiles: ['src/a.ts'] },
      sessionScope: ['src/b.ts'],
      referencedFiles: ['/work/proj/src/c.ts'],
    })
    expect(r.relativeFiles.sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })

  it('同一个文件从多个来源来只出现一次（否则「可修改 N 个文件」计数翻倍）', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: { allowedFiles: ['src/a.ts'] },
      sessionScope: ['src/a.ts'],
      referencedFiles: ['/work/proj/src/a.ts'],
    })
    expect(r.relativeFiles).toEqual(['src/a.ts'])
    expect(r.relativeFiles).toHaveLength(1)
  })
})

describe('computeScope — 相对形态是规范形态', () => {
  it('@ 引用的绝对路径被转成相对路径', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: null,
      sessionScope: [],
      referencedFiles: ['/work/proj/src/deep/a.ts'],
    })
    expect(r.relativeFiles).toEqual(['src/deep/a.ts'])
  })

  it('项目外的引用文件被忽略（不该进范围 —— 它会被主进程拒绝并让整个会话失败）', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: null,
      sessionScope: [],
      referencedFiles: ['/other/place/a.ts'],
    })
    expect(r.relativeFiles).toEqual([])
    expect(r.readonly).toBe(true)
  })

  it('项目级默认里的相对路径原样保留（已是规范形态）', () => {
    const r = computeScope({
      projectPath: PROJ,
      projectDefaults: { allowedFiles: ['src/app.ts'] },
      sessionScope: [],
      referencedFiles: [],
    })
    expect(r.relativeFiles).toEqual(['src/app.ts'])
  })
})

describe('computeScope — 显示与发送是同一个集合', () => {
  it('算出的集合就是发送用的集合（面板显示什么，主进程就收到什么）', () => {
    const input = {
      projectPath: PROJ,
      projectDefaults: { allowedFiles: ['src/a.ts'] } as { allowedFiles: string[] },
      sessionScope: ['src/b.ts'],
      referencedFiles: ['/work/proj/src/c.ts'],
    }
    const r = computeScope(input)
    // 面板显示的每一项都在集合里；集合里每一项都会被发出去
    expect(r.relativeFiles).toContain('src/a.ts')
    expect(r.relativeFiles).toContain('src/b.ts')
    expect(r.relativeFiles).toContain('src/c.ts')
    // 只读判定与集合长度一致 —— 不会出现「显示只读但集合非空」
    expect(r.readonly).toBe(r.relativeFiles.length === 0)
  })
})
