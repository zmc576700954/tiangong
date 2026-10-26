import { describe, it, expect, vi } from 'vitest'
import {
  t, tRaw, getLocale, setLocale, subscribeLocale, resolveLocale,
  nodeTypeLabel, nodeStatusLabel,
  bugSeverityLabel, bugStatusLabel, graphTypeLabel, agentCommandLabel, edgeTypeOptions,
} from '../i18n'
import { zh, en } from '../i18n/resources'

describe('i18n translate', () => {
  it('returns the zh value for a zh locale', () => {
    expect(t('common.save')).toBe(zh['common.save'])
  })

  it('returns the en value for an en locale', () => {
    setLocale('en-US')
    expect(t('common.save')).toBe(en['common.save'])
    setLocale('zh-CN')
  })

  it('falls back to zh when the key is missing in en — never a raw key', () => {
    const key = 'common.__missing_in_en__'
    // 造一个 en 里没有、zh 里有的 key
    ;(zh as Record<string, string>)[key] = '中文兜底'
    setLocale('en-US')
    expect(tRaw(key)).toBe('中文兜底')
    delete (zh as Record<string, string>)[key]
    setLocale('zh-CN')
  })

  it('returns the raw key when the key exists in neither locale', () => {
    expect(tRaw('totally.unknown.key')).toBe('totally.unknown.key')
  })

  it('interpolates {name} placeholders', () => {
    expect(t('common.greeting', { name: '张三' })).toContain('张三')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(tRaw('common.greeting', {})).toContain('{name}')
  })
})

describe('i18n locale state', () => {
  it('defaults to zh-CN', () => {
    expect(getLocale()).toBe('zh-CN')
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocale(listener)
    setLocale('en-US')
    expect(listener).toHaveBeenCalledWith('en-US')
    unsubscribe()
    setLocale('zh-CN')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the locale is unchanged', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocale(listener)
    setLocale('zh-CN')
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('resolveLocale', () => {
  it('accepts en-US', () => {
    expect(resolveLocale('en-US')).toBe('en-US')
  })

  it('accepts zh-CN', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN')
  })

  it('falls back to zh-CN for anything else', () => {
    expect(resolveLocale(undefined)).toBe('zh-CN')
    expect(resolveLocale('fr-FR')).toBe('zh-CN')
    expect(resolveLocale(42)).toBe('zh-CN')
  })
})

describe('type and status labels', () => {
  it('has a label for every NodeType', () => {
    for (const type of ['project', 'module', 'process', 'feature', 'bug', 'wiki-page'] as const) {
      expect(nodeTypeLabel(type)).toBeTruthy()
    }
  })

  it('has a label for every NodeStatus', () => {
    for (const status of ['draft', 'confirmed', 'developing', 'testing', 'review', 'published', 'placeholder'] as const) {
      expect(nodeStatusLabel(status)).toBeTruthy()
    }
  })

  it('keeps the Chinese wording of the existing UI', () => {
    expect(nodeTypeLabel('module')).toBe('业务模块')
    expect(nodeStatusLabel('testing')).toBe('待测试')
    expect(nodeStatusLabel('placeholder')).toBe('占位')
  })

  it('has a label for every BugSeverity and BugStatus', () => {
    for (const severity of ['low', 'medium', 'high', 'critical'] as const) {
      expect(bugSeverityLabel(severity)).toBeTruthy()
    }
    for (const status of ['open', 'fixed', 'verified'] as const) {
      expect(bugStatusLabel(status)).toBeTruthy()
    }
    expect(bugSeverityLabel('critical')).toBe('严重')
    expect(bugStatusLabel('open')).toBe('未修复')
  })

  it('has a label for every GraphType', () => {
    expect(graphTypeLabel('online')).toBe('已上线场景')
    expect(graphTypeLabel('dev')).toBe('开发场景')
  })

  it('returns the command itself when it is unknown', () => {
    expect(agentCommandLabel('implement')).toBe('实现')
    expect(agentCommandLabel('some_unknown_command')).toBe('some_unknown_command')
  })

  it('lists the eight hand-built edge types with label, color and description', () => {
    const options = edgeTypeOptions()
    expect(options.map((o) => o.type)).toEqual([
      'default', 'success', 'failure', 'condition',
      'business-flow', 'semantic', 'dependency', 'co-change',
    ])
    for (const option of options) {
      expect(option.label).toBeTruthy()
      expect(option.color).toMatch(/^#/)
      expect(option.description).toBeTruthy()
    }
    expect(options[0].label).toBe('默认流程')
  })
})

describe('resource parity', () => {
  it('every zh key has a non-empty en value', () => {
    const enMap = en as Record<string, string>
    for (const key of Object.keys(zh)) {
      expect(enMap[key], `missing en translation for ${key}`).toBeTruthy()
    }
  })

  it('every en key exists in zh', () => {
    const zhMap = zh as Record<string, string>
    for (const key of Object.keys(en)) {
      expect(zhMap[key], `orphan en key ${key}`).toBeTruthy()
    }
  })
})
