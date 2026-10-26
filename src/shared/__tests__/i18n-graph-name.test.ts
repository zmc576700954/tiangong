import { describe, it, expect } from 'vitest'
import { localizeGraphName, threadTitle, setLocale } from '../i18n'
import { DEFAULT_THREAD_TITLE } from '../constants'

describe('localizeGraphName', () => {
  it('keeps the Chinese suffix as-is in Chinese mode', () => {
    setLocale('zh-CN')
    expect(localizeGraphName('tiangong - 产品蓝图')).toBe('tiangong - 产品蓝图')
  })

  it('replaces the known suffix with the English one in English mode', () => {
    setLocale('en-US')
    expect(localizeGraphName('tiangong - 产品蓝图')).toBe('tiangong - Product Blueprint')
    setLocale('zh-CN')
  })

  it('replaces the dev graph suffix too', () => {
    setLocale('en-US')
    expect(localizeGraphName('tiangong - 开发场景')).toBe('tiangong - Dev Scenario')
    setLocale('zh-CN')
  })

  it('leaves a name without a known suffix untouched', () => {
    setLocale('en-US')
    expect(localizeGraphName('我的自定义图')).toBe('我的自定义图')
    setLocale('zh-CN')
  })

  it('leaves a name with a different suffix untouched', () => {
    setLocale('en-US')
    expect(localizeGraphName('tiangong - 从其他项目派生')).toBe('tiangong - 从其他项目派生')
    setLocale('zh-CN')
  })

  it('round-trips an already-localized name back to the current locale', () => {
    setLocale('en-US')
    const english = localizeGraphName('tiangong - 产品蓝图')
    setLocale('zh-CN')
    expect(localizeGraphName(english)).toBe('tiangong - 产品蓝图')
  })
})

describe('threadTitle', () => {
  it('translates the default title sentinel', () => {
    setLocale('zh-CN')
    expect(threadTitle(DEFAULT_THREAD_TITLE)).toBe('新会话')
    setLocale('en-US')
    expect(threadTitle(DEFAULT_THREAD_TITLE)).toBe('New Thread')
    setLocale('zh-CN')
  })

  it('leaves a user-renamed title untouched', () => {
    setLocale('zh-CN')
    expect(threadTitle('排查登录超时')).toBe('排查登录超时')
  })
})
