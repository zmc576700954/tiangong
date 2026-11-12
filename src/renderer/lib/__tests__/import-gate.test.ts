// @vitest-environment jsdom
/**
 * 导入查重的分工判定：谁能静默导入、谁必须问用户、谁根本不能导。
 *
 * 这三个分支决定了用户点「生成思维导图」之后看到什么；以前的实现里
 * 「必须问用户」这一支根本不存在（界面永远不传 allowBranchVariant），
 * 于是分支/副本被服务端硬拒、界面静默无反应。这里把它固化成可验收的判定。
 */

import { describe, it, expect } from 'vitest'
import { decideImportGate } from '../import-gate'
import type { ImportPreviewResult } from '@shared/types/ipc'

function preview(overrides: Partial<ImportPreviewResult>): ImportPreviewResult {
  return {
    action: 'allow',
    step: '3c',
    reason: '新项目（无任何匹配信号）',
    dirName: 'tiangong',
    signals: { dirNameSame: false, nameSame: null, similarity: null, sampleCount: 0 },
    remembered: false,
    ...overrides,
  }
}

describe('decideImportGate', () => {
  it('无匹配直接导入', () => {
    expect(decideImportGate(preview({ action: 'allow', step: '3c' }))).toBe('proceed')
  })

  it('图被删后重建同一项目直接导入', () => {
    expect(decideImportGate(preview({ action: 'allow_rebuild', step: '1-rebuild' }))).toBe('proceed')
  })

  it('分支/副本未确认时必须问用户', () => {
    expect(decideImportGate(preview({ action: 'allow_branch_variant', step: '3a-this_time' }))).toBe('confirm')
  })

  it('命中记住的放行规则时不再打扰用户', () => {
    expect(
      decideImportGate(preview({ action: 'allow_branch_variant', step: '3a-remembered', remembered: true })),
    ).toBe('proceed')
  })

  it('同名但内容差异大 → 需要确认', () => {
    expect(decideImportGate(preview({ action: 'allow_with_warning', step: '2b' }))).toBe('confirm')
  })

  it('硬拒绝 → blocked（不静默导入，也不假装可导）', () => {
    for (const step of ['1', '2a', '3b', '3a-auto', '4a']) {
      expect(decideImportGate(preview({ action: 'reject', step }))).toBe('blocked')
    }
  })

  it('未知动作按最保守处理', () => {
    expect(
      decideImportGate(preview({ action: 'something_new' as ImportPreviewResult['action'] })),
    ).toBe('blocked')
  })
})
