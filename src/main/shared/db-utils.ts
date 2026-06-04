/**
 * 数据库相关工具函数
 */

/** 安全的 JSON 解析，解析失败时返回 undefined 并可选打印警告 */
export function safeJsonParse<T>(
  value: string | null | undefined,
  context?: string,
): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    if (context) {
      console.warn(`[DB] Failed to parse JSON for ${context}`)
    }
    return undefined
  }
}
