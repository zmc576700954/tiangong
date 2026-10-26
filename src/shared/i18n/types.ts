/**
 * i18n 基础类型
 *
 * Locale 用字面量类型而非 enum——共享层同时被主进程与渲染进程打包，
 * 字面量类型不产生任何运行时依赖。
 */

export type Locale = 'zh-CN' | 'en-US'

/** 默认语言：中文为主 */
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 兜底语言：英文 */
export const FALLBACK_LOCALE: Locale = 'en-US'

export type { TranslationKey } from './resources'
