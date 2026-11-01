import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  canTransition,
  canTransitionForType,
  validateTransition,
  validateNodeTypeTransition,
  getAllowedTransitions,
  findTransitionPath,
  InvalidStateTransitionError,
  canBugTransition,
  validateBugTransition,
  validateTransitionConsistency,
} from '../state-machine'
import {
  NODE_STATUS_TRANSITIONS,
  NODE_STATUS_VALUES,
  NODE_TYPE_VALUES,
} from '../types'
import type { NodeType } from '../types'

describe('canTransition', () => {
  it('allows draft → confirmed', () => {
    expect(canTransition('draft', 'confirmed')).toBe(true)
  })

  it('allows confirmed → developing', () => {
    expect(canTransition('confirmed', 'developing')).toBe(true)
  })

  it('allows developing → testing', () => {
    expect(canTransition('developing', 'testing')).toBe(true)
  })

  it('allows testing → review', () => {
    expect(canTransition('testing', 'review')).toBe(true)
  })

  it('allows review → published', () => {
    expect(canTransition('review', 'published')).toBe(true)
  })

  it('blocks illegal transition: published → developing', () => {
    expect(canTransition('published', 'developing')).toBe(false)
  })

  it('blocks illegal transition: draft → published', () => {
    expect(canTransition('draft', 'published')).toBe(false)
  })

  it('allows same state (no-op)', () => {
    expect(canTransition('confirmed', 'confirmed')).toBe(true)
  })

  it('allows placeholder → draft', () => {
    expect(canTransition('placeholder', 'draft')).toBe(true)
  })

  it('allows placeholder → confirmed', () => {
    expect(canTransition('placeholder', 'confirmed')).toBe(true)
  })
})

describe('validateTransition', () => {
  it('throws on illegal transition', () => {
    expect(() => validateTransition('draft', 'published', 'node-1')).toThrow(InvalidStateTransitionError)
  })

  it('does not throw on legal transition', () => {
    expect(() => validateTransition('draft', 'confirmed')).not.toThrow()
  })
})

describe('getAllowedTransitions', () => {
  it('returns correct transitions from confirmed', () => {
    const transitions = getAllowedTransitions('confirmed')
    expect(transitions).toContain('developing')
    expect(transitions).toContain('draft')
    expect(transitions).toContain('placeholder')
    expect(transitions).toContain('published')
  })
})

describe('findTransitionPath', () => {
  it('returns direct path for legal direct transition', () => {
    expect(findTransitionPath('draft', 'confirmed')).toEqual(['draft', 'confirmed'])
  })

  it('returns multi-step path when indirect', () => {
    const path = findTransitionPath('draft', 'published')
    expect(path).not.toBeNull()
    expect(path!.length).toBeGreaterThan(2)
    expect(path![0]).toBe('draft')
    expect(path![path!.length - 1]).toBe('published')
  })
})

describe('canBugTransition', () => {
  it('allows open → fixed', () => {
    expect(canBugTransition('open', 'fixed')).toBe(true)
  })

  it('allows fixed → verified', () => {
    expect(canBugTransition('fixed', 'verified')).toBe(true)
  })

  it('allows fixed → open (reopen)', () => {
    expect(canBugTransition('fixed', 'open')).toBe(true)
  })

  it('allows verified → open (reopen)', () => {
    expect(canBugTransition('verified', 'open')).toBe(true)
  })

  it('blocks open → verified (must pass fixed)', () => {
    expect(canBugTransition('open', 'verified')).toBe(false)
  })

  it('allows same state (no-op)', () => {
    expect(canBugTransition('open', 'open')).toBe(true)
    expect(canBugTransition('verified', 'verified')).toBe(true)
  })
})

describe('validateBugTransition', () => {
  it('throws on illegal bug transition', () => {
    expect(() => validateBugTransition('open', 'verified', 'bug-1')).toThrow(InvalidStateTransitionError)
  })

  it('does not throw on legal bug transition', () => {
    expect(() => validateBugTransition('open', 'fixed')).not.toThrow()
  })

  it('includes bugId in error message when provided', () => {
    expect(() => validateBugTransition('open', 'verified', 'bug-1')).toThrow('bug-1')
  })
})

describe('canTransitionForType', () => {
  it('按节点类型判定，而非只看状态', () => {
    const moduleAllows = NODE_STATUS_TRANSITIONS.module.some(
      t => t.from === 'draft' && t.to === 'developing',
    )
    expect(canTransitionForType('module', 'draft', 'developing')).toBe(moduleAllows)
    expect(canTransitionForType('feature', 'draft', 'developing')).toBe(true)
  })

  it('同一状态恒等允许（无需转换）', () => {
    for (const type of NODE_TYPE_VALUES) {
      for (const status of NODE_STATUS_VALUES) {
        expect(canTransitionForType(type, status, status)).toBe(true)
      }
    }
  })

  it('未知 NodeType 保守拒绝', () => {
    expect(canTransitionForType('not-a-real-type' as NodeType, 'draft', 'confirmed')).toBe(false)
    expect(canTransitionForType('not-a-real-type' as NodeType, 'draft', 'draft')).toBe(true)
  })

  it('published 对非 wiki-page 类型是终态', () => {
    for (const type of NODE_TYPE_VALUES) {
      if (type === 'wiki-page') continue
      expect(canTransitionForType(type, 'published', 'confirmed')).toBe(false)
      expect(canTransitionForType(type, 'published', 'draft')).toBe(false)
      expect(canTransitionForType(type, 'published', 'placeholder')).toBe(false)
    }
    // wiki-page 是唯一允许 published → X 的类型
    expect(canTransitionForType('wiki-page', 'published', 'confirmed')).toBe(true)
  })

  /**
   * 核心断言：把「渲染端判定」与「主进程校验」钉在一起。
   *
   * 渲染端放行、主进程抛 IpcError —— 就是「右键改状态点了没反应」的根因。
   * 这里穷举 NodeType × NodeStatus × NodeStatus，逐格比对两条路径的结论。
   */
  it('与 validateNodeTypeTransition 的结论完全一致', () => {
    const mismatches: string[] = []
    for (const type of NODE_TYPE_VALUES) {
      for (const from of NODE_STATUS_VALUES) {
        for (const to of NODE_STATUS_VALUES) {
          const allowed = canTransitionForType(type, from, to)
          let mainProcessAllows = true
          try {
            validateNodeTypeTransition(type, from, to, 'node-consistency')
          } catch {
            mainProcessAllows = false
          }
          if (allowed !== mainProcessAllows) {
            mismatches.push(`${type}: ${from} → ${to} (判定=${allowed}, 主进程=${mainProcessAllows})`)
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('validateNodeTypeTransition 抛错时判定为 false', () => {
    expect(() => validateNodeTypeTransition('module', 'draft', 'published', 'node-1'))
      .toThrow(InvalidStateTransitionError)
    expect(canTransitionForType('module', 'draft', 'published')).toBe(false)
  })
})

describe('validateTransitionConsistency', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('returns 0 when rules are consistent', () => {
    expect(validateTransitionConsistency()).toBe(0)
    expect(consoleSpy).not.toHaveBeenCalled()
  })
})
