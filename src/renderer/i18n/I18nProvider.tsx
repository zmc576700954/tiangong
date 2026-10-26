import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { resolveLocale, setLocale, subscribeLocale, tIn } from '@shared/i18n'
import type { Locale } from '@shared/i18n/types'
import { I18nContext } from './context'
import type { I18nContextValue } from './context'

/**
 * 渲染进程的语言 Provider。
 *
 * 语言有三个来源，优先级从高到低：
 *   1. preload 同步暴露的初值（`window.electronAPI.locale`）——首屏就用对，不闪
 *   2. 主进程通过 `locale:changed` 推送——跨窗口同步
 *   3. 本进程共享层的变化——组件之间自己调用 setLocale 时保持一致
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(
    () => resolveLocale(window.electronAPI?.locale),
  )

  const applyLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    setLocale(next)
  }, [])

  // 模块级共享层与 Provider 保持一致——
  // store / toast 用的模块级 t() 必须和界面说同一种语言。
  useLayoutEffect(() => {
    setLocale(locale)
  }, [locale])

  // 共享层在本进程内被改动
  useEffect(() => subscribeLocale((next) => setLocaleState(next)), [])

  // 主进程推送（切换语言后广播到所有窗口）
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onLocaleChanged?.((raw) => {
      applyLocale(resolveLocale(raw))
    })
    return () => unsubscribe?.()
  }, [applyLocale])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: (key, vars) => tIn(locale, key, vars),
      setLocale: applyLocale,
    }),
    [locale, applyLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}
