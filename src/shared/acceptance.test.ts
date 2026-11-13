/**
 * 节点验收项共享纯函数（FR-S1-02）。
 *
 * 重点覆盖三件容易被写错的事：
 *  1. legacy `string[]` 归一化后原文逐字不变（进 expected 与 text 两处），id 确定性稳定；
 *  2. 校验 fail-closed，且错误能定位到「第 N 条 + 字段」；
 *  3. `deriveAcceptanceTexts` 反向派生后，`acceptanceCriteria: string[]` 形状不变
 *     ——该列受 `isStringArray` 守卫，写对象会整体退回 `[]`。
 */

import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_LIMITS,
  deriveAcceptanceTexts,
  isAcceptanceItem,
  isRequired,
  makeAcceptanceItemId,
  normalizeAcceptanceItems,
  serializeAcceptanceItems,
  validateAcceptanceItems,
  validateRelativePath,
  type AcceptanceItem,
} from './acceptance'

describe('normalizeAcceptanceItems', () => {
  it('把 legacy 字符串逐条转为 manual，且原文逐字保留在 expected 与 text', () => {
    const legacy = ['页面能打开', '提交后列表出现新记录', '  前后有空格也要保留  ']
    const items = normalizeAcceptanceItems(legacy)

    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      id: 'acc_0',
      type: 'manual',
      expected: '页面能打开',
      text: '页面能打开',
      required: true,
      provenance: 'legacy_free_text',
    })
    // 原文不得改写（含空白）
    expect(items[2]?.expected).toBe('  前后有空格也要保留  ')
    expect(items[2]?.text).toBe('  前后有空格也要保留  ')
  })

  it('同一输入两次归一化结果一致（id 稳定，重载不漂移）', () => {
    const legacy = ['a', 'b']
    expect(normalizeAcceptanceItems(legacy)).toEqual(normalizeAcceptanceItems(legacy))
  })

  it('结构化条目原样返回，不擅自补 required', () => {
    const structured: AcceptanceItem[] = [
      { type: 'command', expected: 'npm test', stdout_contains: 'passed', timeout_ms: 60_000 },
    ]
    const items = normalizeAcceptanceItems(structured)
    expect(items[0]).toEqual(structured[0])
    expect(items[0]?.required).toBeUndefined()
  })

  it('丢弃空字符串与非法项，不伪造条目', () => {
    const items = normalizeAcceptanceItems([
      '',
      '   ',
      { type: 'unknown', expected: 'x' },
      { type: 'manual' },
      { type: 'manual', expected: '有效项' },
    ] as unknown as AcceptanceItem[])
    expect(items).toHaveLength(1)
    expect(items[0]?.expected).toBe('有效项')
  })

  it('null / undefined / 非数组返回空数组', () => {
    expect(normalizeAcceptanceItems(null)).toEqual([])
    expect(normalizeAcceptanceItems(undefined)).toEqual([])
    expect(normalizeAcceptanceItems('not-array' as unknown as AcceptanceItem[])).toEqual([])
  })
})

describe('deriveAcceptanceTexts', () => {
  it('优先 text，缺省回退 expected', () => {
    const texts = deriveAcceptanceTexts([
      { type: 'command', expected: 'npm test', text: '跑单测' },
      { type: 'file_check', expected: 'src/a.ts' },
      { type: 'manual', expected: '人工确认值', text: '   ' },
    ])
    expect(texts).toEqual(['跑单测', 'src/a.ts', '人工确认值'])
  })

  it('归一化再派生，得到与原始 legacy 完全相同的字符串数组', () => {
    const legacy = ['第一条', '第二条']
    expect(deriveAcceptanceTexts(normalizeAcceptanceItems(legacy))).toEqual(legacy)
  })
})

describe('isRequired / isAcceptanceItem / makeAcceptanceItemId', () => {
  it('required 缺省视为必过', () => {
    expect(isRequired({ type: 'manual', expected: 'x' })).toBe(true)
    expect(isRequired({ type: 'manual', expected: 'x', required: true })).toBe(true)
    expect(isRequired({ type: 'manual', expected: 'x', required: false })).toBe(false)
  })

  it('形状守卫要求 type 合法且 expected 非空', () => {
    expect(isAcceptanceItem({ type: 'manual', expected: 'x' })).toBe(true)
    expect(isAcceptanceItem({ type: 'manual', expected: '  ' })).toBe(false)
    expect(isAcceptanceItem({ type: 'bogus', expected: 'x' })).toBe(false)
    expect(isAcceptanceItem(null)).toBe(false)
  })

  it('id 生成避开已存在值', () => {
    expect(makeAcceptanceItemId(0)).toBe('acc_0')
    expect(makeAcceptanceItemId(0, ['acc_0', 'acc_1'])).toBe('acc_2')
  })
})

describe('validateAcceptanceItems（fail-closed）', () => {
  it('空数组视为合法（是否允许无验收由调用方决定）', () => {
    expect(validateAcceptanceItems([])).toEqual({ ok: true, errors: [] })
  })

  it('非数组直接拒绝', () => {
    const result = validateAcceptanceItems('x')
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('必须是数组')
  })

  it('expected 为空时定位到第 N 条并按类型给出字段名', () => {
    const result = validateAcceptanceItems([
      { type: 'manual', expected: 'ok', id: 'a' },
      { type: 'command', expected: '   ' },
    ])
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('第 2 条：命令不能为空')
  })

  it('manual 缺 id 被拒绝（否则人工确认无法锚定）', () => {
    const result = validateAcceptanceItems([{ type: 'manual', expected: 'x' }])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('人工确认项必须有 id')
  })

  it('file_check 拒绝绝对路径与 .. 逃逸', () => {
    const absolute = validateAcceptanceItems([{ type: 'file_check', expected: '/etc/passwd' }])
    expect(absolute.ok).toBe(false)
    expect(absolute.errors[0]).toContain('相对路径')

    const escape = validateAcceptanceItems([{ type: 'file_check', expected: '../outside.txt' }])
    expect(escape.ok).toBe(false)
    expect(escape.errors[0]).toContain('..')

    expect(validateAcceptanceItems([{ type: 'file_check', expected: 'src/a.ts' }]).ok).toBe(true)
  })

  it('command 超时非法与超上限被拒绝', () => {
    const negative = validateAcceptanceItems([
      { type: 'command', expected: 'npm test', timeout_ms: -1 },
    ])
    expect(negative.ok).toBe(false)

    const tooLong = validateAcceptanceItems([
      { type: 'command', expected: 'npm test', timeout_ms: ACCEPTANCE_LIMITS.maxTimeoutMs + 1 },
    ])
    expect(tooLong.ok).toBe(false)
    expect(tooLong.errors[0]).toContain(String(ACCEPTANCE_LIMITS.maxTimeoutMs))
  })

  it('超出 20 条上限被拒绝', () => {
    const many = Array.from({ length: ACCEPTANCE_LIMITS.maxItems + 1 }, (_, i) => ({
      type: 'manual' as const,
      expected: `第 ${i} 条`,
      id: `acc_${i}`,
    }))
    const result = validateAcceptanceItems(many)
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain(`最多 ${ACCEPTANCE_LIMITS.maxItems} 条`)
  })

  it('text 超长被拒绝', () => {
    const result = validateAcceptanceItems([
      { type: 'manual', expected: 'x', id: 'a', text: 'y'.repeat(ACCEPTANCE_LIMITS.maxText + 1) },
    ])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('不能超过')
  })

  it('required 非布尔被拒绝', () => {
    const result = validateAcceptanceItems([
      { type: 'manual', expected: 'x', id: 'a', required: 'yes' },
    ])
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toContain('布尔')
  })
})

describe('validateRelativePath', () => {
  it('放行正常相对路径，拦截绝对路径与父级逃逸', () => {
    expect(validateRelativePath('src/main/index.ts')).toBeNull()
    expect(validateRelativePath('src\\main\\index.ts')).toBeNull()
    expect(validateRelativePath('')).not.toBeNull()
    expect(validateRelativePath('/abs')).not.toBeNull()
    expect(validateRelativePath('C:\\abs')).not.toBeNull()
    expect(validateRelativePath('a/../../b')).not.toBeNull()
  })
})

describe('serializeAcceptanceItems', () => {
  it('只输出执行器认识的键，且不丢 required=false', () => {
    const json = serializeAcceptanceItems([
      { id: 'a', type: 'command', expected: 'npm test', stdout_contains: 'ok', timeout_ms: 1000 },
      { type: 'manual', expected: '人工看', id: 'b', required: false, provenance: 'legacy_free_text' },
      { type: 'file_check', expected: 'src/a.ts', content_contains: 'export' },
    ])
    const parsed = JSON.parse(json) as Record<string, unknown>[]

    expect(parsed[0]).toEqual({
      type: 'command',
      expected: 'npm test',
      id: 'a',
      stdout_contains: 'ok',
      timeout_ms: 1000,
    })
    expect(parsed[1]).toMatchObject({ required: false, provenance: 'legacy_free_text' })
    expect(parsed[2]).toEqual({
      type: 'file_check',
      expected: 'src/a.ts',
      content_contains: 'export',
    })
    // command 专属键不得泄漏到 file_check 条目
    expect(parsed[2]).not.toHaveProperty('timeout_ms')
  })
})
