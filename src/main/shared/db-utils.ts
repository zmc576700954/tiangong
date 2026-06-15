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
 * 安全的 JSON 解析
 * - 传入 validator 时执行运行时类型校验（推荐）
 * - 不传 validator 时仅做 JSON.parse + 类型断言（向后兼容，不安全）
 * @param value - JSON 字符串
 * @param validatorOrContext - 类型守卫函数，或上下文字符串（向后兼容）
 * @param context - 上下文信息，用于错误日志（仅在 validatorOrContext 为函数时使用）
 */
export function safeJsonParse<T>(
  value: string | null | undefined,
  validatorOrContext?: ((val: unknown) => val is T) | string,
  context?: string,
): T | undefined {
  if (value == null) return undefined
  const ctx = typeof validatorOrContext === 'string' ? validatorOrContext : context
  try {
    const parsed = JSON.parse(value)
    if (typeof validatorOrContext === 'function') {
      if (validatorOrContext(parsed)) return parsed
      logger.warn(`JSON validation failed${ctx ? ` for ${ctx}` : ''}: parsed value does not match expected type`)
      return undefined
    }
    return parsed as T
  } catch {
    if (ctx) {
      logger.warn(`Failed to parse JSON for ${ctx}`)
    }
    return undefined
  }
}
