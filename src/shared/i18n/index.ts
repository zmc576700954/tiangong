import { zh, en } from './resources'
import type { TranslationKey } from './resources'
import { DEFAULT_LOCALE } from './types'
import type { Locale } from './types'
import { DEFAULT_THREAD_TITLE, GRAPH_INDEX_TITLE, GRAPH_LOG_TITLE } from '../constants'
import type { BugSeverity, BugStatus, EdgeType, GraphType, NodeStatus, NodeType } from '../types/graph'

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

/**
 * 标签查表函数。
 *
 * `locale` 缺省取模块级当前语言——给 store / hook / 主进程用。
 * React 组件要传 `useI18n()` 里的 locale：组件只有消费了 i18n context
 * 才会在语言切换时重渲染，光调模块级函数不会刷新。
 */
export function nodeTypeLabel(type: NodeType, locale: Locale = getLocale()): string {
  return tIn(locale, NODE_TYPE_KEYS[type])
}

export function nodeStatusLabel(status: NodeStatus, locale: Locale = getLocale()): string {
  return tIn(locale, NODE_STATUS_KEYS[status])
}

const BUG_SEVERITY_KEYS: Record<BugSeverity, TranslationKey> = {
  low: 'bug.severity.low',
  medium: 'bug.severity.medium',
  high: 'bug.severity.high',
  critical: 'bug.severity.critical',
}

const BUG_STATUS_KEYS: Record<BugStatus, TranslationKey> = {
  open: 'bug.status.open',
  fixed: 'bug.status.fixed',
  verified: 'bug.status.verified',
}

const GRAPH_TYPE_KEYS: Record<GraphType, TranslationKey> = {
  online: 'graph.type.online',
  dev: 'graph.type.dev',
}

/** 'wiki-link' 由 WikiLinkService 自动落边，不出现在手建边选项里 */
type HandBuiltEdgeType = Exclude<EdgeType, 'wiki-link'>

const EDGE_TYPE_KEYS: Record<HandBuiltEdgeType, TranslationKey> = {
  default: 'edge.default.label',
  success: 'edge.success.label',
  failure: 'edge.failure.label',
  condition: 'edge.condition.label',
  'business-flow': 'edge.businessFlow.label',
  semantic: 'edge.semantic.label',
  dependency: 'edge.dependency.label',
  'co-change': 'edge.coChange.label',
}

const EDGE_TYPE_DESC_KEYS: Record<HandBuiltEdgeType, TranslationKey> = {
  default: 'edge.default.description',
  success: 'edge.success.description',
  failure: 'edge.failure.description',
  condition: 'edge.condition.description',
  'business-flow': 'edge.businessFlow.description',
  semantic: 'edge.semantic.description',
  dependency: 'edge.dependency.description',
  'co-change': 'edge.coChange.description',
}

const EDGE_TYPE_COLORS: Record<HandBuiltEdgeType, string> = {
  default: '#94a3b8',
  success: '#22c55e',
  failure: '#ef4444',
  condition: '#f59e0b',
  'business-flow': '#3b82f6',
  semantic: '#8b5cf6',
  dependency: '#64748b',
  'co-change': '#ec4899',
}

const AGENT_COMMAND_KEYS: Record<string, TranslationKey> = {
  implement: 'command.implement',
  fix_bug: 'command.fixBug',
  refactor: 'command.refactor',
  add_test: 'command.addTest',
}

export function bugSeverityLabel(severity: BugSeverity, locale: Locale = getLocale()): string {
  return tIn(locale, BUG_SEVERITY_KEYS[severity])
}

export function bugStatusLabel(status: BugStatus, locale: Locale = getLocale()): string {
  return tIn(locale, BUG_STATUS_KEYS[status])
}

export function graphTypeLabel(type: GraphType, locale: Locale = getLocale()): string {
  return tIn(locale, GRAPH_TYPE_KEYS[type])
}

/** 未知 command 原样返回 command 本身，不报错 */
export function agentCommandLabel(command: string, locale: Locale = getLocale()): string {
  const key = AGENT_COMMAND_KEYS[command]
  return key ? tIn(locale, key) : command
}

export function edgeTypeOptions(locale: Locale = getLocale()): { type: EdgeType; label: string; color: string; description: string }[] {
  return (Object.keys(EDGE_TYPE_KEYS) as HandBuiltEdgeType[]).map((type) => ({
    type,
    label: tIn(locale, EDGE_TYPE_KEYS[type]),
    color: EDGE_TYPE_COLORS[type],
    description: tIn(locale, EDGE_TYPE_DESC_KEYS[type]),
  }))
}

/** 连线类型在画布上的短标签——wiki-link 也要有，所以不能只查 EDGE_TYPE_KEYS */
export function edgeTypeLabel(type: EdgeType, locale: Locale = getLocale()): string {
  if (type === 'wiki-link') return tIn(locale, 'edge.wikiLink.label')
  const key = EDGE_TYPE_KEYS[type]
  return key ? tIn(locale, key) : type
}

/**
 * 图名后缀映射——存储值固定为中文，展示时按语言替换。
 * `zh` 是入库时的原样后缀，`en` 是同一条目的英文形态（用于把已本地化的名字换回来）。
 */
const GRAPH_NAME_SUFFIXES: { zh: string; en: string; key: TranslationKey }[] = [
  { zh: '产品蓝图', en: 'Product Blueprint', key: 'graph.nameSuffix.online' },
  { zh: '开发场景', en: 'Dev Scenario', key: 'graph.nameSuffix.dev' },
]

/**
 * 把图名里已知的后缀换成当前语言——只认后缀表里的两条，其他后缀原样返回。
 * React 组件要传 `useI18n()` 里的 locale，否则语言切换时不会重渲染。
 */
export function localizeGraphName(name: string, locale: Locale = getLocale()): string {
  for (const suffix of GRAPH_NAME_SUFFIXES) {
    for (const candidate of [suffix.zh, suffix.en]) {
      const marker = ` - ${candidate}`
      if (name.endsWith(marker)) {
        return `${name.slice(0, name.length - marker.length)} - ${tIn(locale, suffix.key)}`
      }
    }
  }
  return name
}

/**
 * 会话标题——存储值是 DEFAULT_THREAD_TITLE 时按语言显示，其余原样返回。
 * 存储值不变，首条消息自动改名的判定仍能命中。
 */
export function threadTitle(title: string, locale: Locale = getLocale()): string {
  return title === DEFAULT_THREAD_TITLE ? tIn(locale, 'thread.defaultTitle') : title
}

/**
 * Wiki 特殊页的展示名。
 * 存储标题（GRAPH_INDEX_TITLE / GRAPH_LOG_TITLE）是英文标识符——
 * WikiIndexService 靠它解析 [[Graph Index]] 这类 wikilink，改了就断链。
 * 展示时按语言替换，链接目标与页面正文保持原样。
 */
const WIKI_SPECIAL_PAGE_TITLES: { id: string; key: TranslationKey }[] = [
  { id: GRAPH_INDEX_TITLE, key: 'wiki.specialPage.index' },
  { id: GRAPH_LOG_TITLE, key: 'wiki.specialPage.log' },
]

export function wikiPageTitle(title: string, locale: Locale = getLocale()): string {
  const found = WIKI_SPECIAL_PAGE_TITLES.find((s) => s.id === title)
  return found ? tIn(locale, found.key) : title
}
