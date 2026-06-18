/**
 * 数据库相关工具函数
 */

import { createLogger } from './logger'

const logger = createLogger('DB')

/**
 * 不安全的 JSON 解析（无运行时类型校验）
 * @deprecated 使用 safeJsonParse 并传入 validator 参数确保类型安全
 */
export function unsafeJsonParse<T>(
  value: string | null | undefined,
  context?: string,
): T | undefined {
  if (value == null) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    if (context) {
      logger.warn(`Failed to parse JSON for ${context}`)
    }
    return undefined
  }
}

/**
 * 安全的 JSON 解析（泛型版本，带 fallback 和可选 validator）
 * - 传入 validator 时执行运行时类型校验（推荐）
 * - 不传 validator 时仅做 JSON.parse + 类型断言（向后兼容，不安全）
 * @param raw - JSON 字符串
 * @param fallback - 解析失败或校验不通过时的默认返回值
 * @param validator - 可选的类型守卫函数
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T, validator?: (val: unknown) => val is T): T {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    if (validator && !validator(parsed)) return fallback
    return parsed as T
  } catch {
    return fallback
  }
}
