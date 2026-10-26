import { describe, it, expect, vi } from 'vitest'
import {
  t, tRaw, getLocale, setLocale, subscribeLocale, resolveLocale,
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
