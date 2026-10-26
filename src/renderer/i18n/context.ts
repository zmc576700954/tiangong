import { createContext } from 'react'
import { t as translate } from '@shared/i18n'
import { DEFAULT_LOCALE } from '@shared/i18n/types'
import type { TranslationKey } from '@shared/i18n'
import type { Locale } from '@shared/i18n/types'

export interface I18nContextValue {
  locale: Locale
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string
  setLocale: (locale: Locale) => void
}

/**
 * 默认 context 必须存在——没有 Provider 时组件会拿到 undefined 并崩，
 * 现有 4 个无 Provider 的 .test.tsx 依赖这个回落。
 */
export const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key, vars) => translate(key, vars),
  setLocale: () => {},
})
