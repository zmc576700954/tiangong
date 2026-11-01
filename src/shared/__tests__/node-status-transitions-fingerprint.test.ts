/**
 * NODE_STATUS_TRANSITIONS 的字面量指纹（fingerprint）
 *
 * 为什么需要这份"手抄"数据：
 *
 * 既有套件（state-machine.test.ts）能覆盖两类问题 ——
 * 1. 「strict ⊂ loose」：per-type 矩阵若新增一格、而 loose 表不允许，会被抓到；
 * 2. 「predicate 不得改回 loose 表」：把 canTransitionForType 改回读 loose 表，
 *    49 个格子（loose 放行、矩阵拒绝）会立刻变红。
 *
 * 但这两类都建立在"期望值从矩阵自身推导"的前提上，**抓不到矩阵自身的增删改**：
 * 只要改动落在 loose 表本就允许的范围内，套件依旧全绿。而矩阵正是 UI 决定
 * "给出哪些状态格子"的唯一依据 —— 改了矩阵，UI 行为静默改变。
 *
 * 所以这里把矩阵的每一行写成**字面量**，当作独立的第三方基准：
 * 增一行、删一行、改一行、重复一行，测试都会失败，并在失败信息里点名
 * 是哪个类型的哪一条转换出了问题。
 *
 * ⚠️ 这份字面量是从 src/shared/types/graph.ts 的 NODE_STATUS_TRANSITIONS
 * 逐行抄下来的，**不是从矩阵计算出来的**（从矩阵算就等于自我循环，
 * 和被测对象同源，抓不到任何回归）。改动矩阵时必须同步更新本文件。
 */

import { describe, it, expect } from 'vitest'
import { NODE_STATUS_TRANSITIONS, NODE_TYPE_VALUES } from '../types'
import type { NodeType } from '../types'

/**
 * 每种节点类型允许的转换矩阵（字面量）。
 *
 * 格式：`from→to`。行序与 src/shared/types/graph.ts 中的定义一致，便于逐行比对。
 * 行数：project 12 / module 12 / process 12 / feature 17 / bug 14 / wiki-page 10。
 */
const EXPECTED_TRANSITIONS: Record<NodeType, readonly string[]> = {
  project: [
    'draft→confirmed',
    'confirmed→developing',
    'confirmed→draft',
    'confirmed→placeholder',
    'developing→confirmed',
    'developing→draft',
    'developing→placeholder',
    'developing→testing',
    'testing→developing',
    'testing→review',
    'review→testing',
    'review→published',
  ],
  module: [
    'draft→confirmed',
    'confirmed→developing',
    'confirmed→draft',
    'confirmed→placeholder',
    'developing→confirmed',
    'developing→draft',
    'developing→placeholder',
    'developing→testing',
    'testing→developing',
    'testing→review',
    'review→testing',
    'review→published',
  ],
  process: [
    'draft→confirmed',
    'confirmed→developing',
    'confirmed→draft',
    'confirmed→placeholder',
    'developing→confirmed',
    'developing→draft',
    'developing→placeholder',
    'developing→testing',
    'testing→developing',
    'testing→review',
    'review→testing',
    'review→published',
  ],
  feature: [
    'placeholder→developing',
    'placeholder→draft',
    'placeholder→confirmed',
    'draft→confirmed',
    'draft→developing',
    'draft→placeholder',
    'confirmed→developing',
    'confirmed→draft',
    'confirmed→placeholder',
    'developing→placeholder',
    'developing→testing',
    'developing→confirmed',
    'developing→draft',
    'testing→developing',
    'testing→review',
    'review→testing',
    'review→published',
  ],
  bug: [
    'draft→developing',
    'draft→confirmed',
    'draft→placeholder',
    'confirmed→developing',
    'confirmed→draft',
    'confirmed→placeholder',
    'developing→draft',
    'developing→confirmed',
    'developing→placeholder',
    'developing→testing',
    'testing→developing',
    'testing→review',
    'review→testing',
    'review→published',
  ],
  'wiki-page': [
    'draft→confirmed',
    'draft→placeholder',
    'confirmed→draft',
    'confirmed→placeholder',
    'confirmed→published',
    'published→confirmed',
    'published→draft',
    'published→placeholder',
    'placeholder→draft',
    'placeholder→confirmed',
  ],
}

/** 矩阵某一类型的实际单元格（`from→to` 字符串） */
function actualCells(type: NodeType): string[] {
  return NODE_STATUS_TRANSITIONS[type].map((t) => `${t.from}→${t.to}`)
}

/**
 * 比对字面量与矩阵，返回可读的问题描述列表。
 *
 * 覆盖四种破坏方式：
 * - 矩阵少了一行（"缺少转换 X"）
 * - 矩阵多了一行（"多出转换 X"）
 * - 矩阵把一行改成了别的（同时报"缺少"和"多出"）
 * - 矩阵里出现了重复行（"重复行"）
 */
function diffCells(expected: readonly string[], actual: readonly string[]): string[] {
  const problems: string[] = []

  for (const cell of expected) {
    if (!actual.includes(cell)) problems.push(`缺少转换 ${cell}`)
  }
  for (const cell of actual) {
    if (!expected.includes(cell)) problems.push(`多出转换 ${cell}`)
  }
  // 集合相同但数量不同 —— 只能是矩阵里有重复行
  if (problems.length === 0 && actual.length !== expected.length) {
    problems.push(`存在重复行（矩阵 ${actual.length} 行 / 指纹 ${expected.length} 行）`)
  }

  return problems
}

describe('NODE_STATUS_TRANSITIONS 字面量指纹', () => {
  for (const type of NODE_TYPE_VALUES) {
    it(`${type} 的转换矩阵与字面量指纹完全一致`, () => {
      const problems = diffCells(EXPECTED_TRANSITIONS[type], actualCells(type))

      // 失败信息里点名类型和出问题的转换，作者改矩阵时立刻知道是哪一行
      expect(problems, `${type}：${problems.join('；')}`).toEqual([])
    })
  }

  it('指纹覆盖全部节点类型，行数完整', () => {
    // 指纹漏了某种类型 → 这里红
    expect(Object.keys(EXPECTED_TRANSITIONS).sort()).toEqual([...NODE_TYPE_VALUES].sort())
    // 指纹里某类型的行被删掉 → 这里红（顺序与 NODE_TYPE_VALUES 一致）
    expect(NODE_TYPE_VALUES.map((type) => EXPECTED_TRANSITIONS[type].length)).toEqual([
      12, 12, 12, 17, 14, 10,
    ])
  })

  it('矩阵本身的键集与 NODE_TYPE_VALUES 一致（运行时校验）', () => {
    expect(Object.keys(NODE_STATUS_TRANSITIONS).sort()).toEqual([...NODE_TYPE_VALUES].sort())
  })
})
