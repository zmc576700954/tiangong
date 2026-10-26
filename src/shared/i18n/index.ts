import { zh, en } from './resources'
import type { TranslationKey } from './resources'
import { DEFAULT_LOCALE } from './types'
import type { Locale } from './types'
import type { NodeStatus, NodeType } from '../types/graph'

export type { TranslationKey } from './resources'
export type { Locale } from './types'

/**
 * 共享 i18n 层
 *
 * 注意：这个模块会被 Vite 分别打包进主进程与渲染进程，运行时是**两份互不相通的实例**。
 * 跨进程同步只能靠主→渲染的 `locale:changed` 推送通道，不要假设这里的
 * setLocale() 能影响另一个进程。
 */

let currentLocale: Locale = DEFAULT_LOCALE
const listeners = new Set<(locale: Locale) => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  for (const listener of listeners) listener(locale)
}

export function subscribeLocale(listener: (locale: Locale) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 把任意输入收敛成合法 locale——主进程、渲染进程共用同一套判定 */
export function resolveLocale(value: unknown): Locale {
  return value === 'en-US' ? 'en-US' : DEFAULT_LOCALE
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

function lookup(locale: Locale, key: string): string | undefined {
  const table = locale === 'zh-CN' ? zh : en
  return (table as Record<string, string>)[key]
}

/**
 * 按指定语言翻译。
 * 渲染进程的 Provider 用它取首帧文案——模块级 currentLocale 此时可能还是默认值，
 * 直接用 t() 会在切到英文时闪一下中文。
 */
export function tIn(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const found = lookup(locale, key) ?? lookup(DEFAULT_LOCALE, key)
  if (found === undefined) {
    console.warn(`[i18n] missing translation key: ${key}`)
    return interpolate(key, vars)
  }
  return interpolate(found, vars)
}

/**
 * 宽松翻译——动态 key 专用。
 * 查找顺序：当前语言 → 中文（DEFAULT_LOCALE）→ key 本身。
 * 回落中文而不是英文：英文界面下漏翻的 key 显示成裸 key 比显示中文更糟。
 */
export function tRaw(key: string, vars?: Record<string, string | number>): string {
  return tIn(currentLocale, key, vars)
}

/** 严格翻译——key 写错直接编译报错 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  return tRaw(key, vars)
}

const NODE_TYPE_KEYS: Record<NodeType, TranslationKey> = {
  project: 'nodeType.project',
  module: 'nodeType.module',
  process: 'nodeType.process',
  feature: 'nodeType.feature',
  bug: 'nodeType.bug',
  'wiki-page': 'nodeType.wikiPage',
}

const NODE_STATUS_KEYS: Record<NodeStatus, TranslationKey> = {
  draft: 'status.draft',
  confirmed: 'status.confirmed',
  developing: 'status.developing',
  testing: 'status.testing',
  review: 'status.review',
  published: 'status.published',
  placeholder: 'status.placeholder',
}

export function nodeTypeLabel(type: NodeType): string {
  return t(NODE_TYPE_KEYS[type])
}

export function nodeStatusLabel(status: NodeStatus): string {
  return t(NODE_STATUS_KEYS[status])
}
