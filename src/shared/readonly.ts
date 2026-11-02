/**
 * 只读推导：会话是不是「只读」。
 *
 * 语义：**没有指定可改哪些文件，就是只读**。
 *
 * 显式 `readOnly` 优先（`false` 可以强制放开），未指定时按 `allowedFiles`
 * 是否为空推导。这样「用户没圈定范围」不会被解读成「可以随便改」。
 */
export function resolveReadonly(config: {
  allowedFiles: string[]
  readOnly?: boolean
}): boolean {
  if (config.readOnly !== undefined) return config.readOnly
  return config.allowedFiles.length === 0
}
