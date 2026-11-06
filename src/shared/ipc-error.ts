/**
 * IPC 错误编解码（main → preload → renderer 全链路）。
 *
 * 背景：Electron `ipcMain.handle` 只能可靠地把 `Error.message` 带到 renderer；
 * 抛出 plain object 会被压平成字符串，renderer 拿到的是
 * `Error invoking remote method 'x': [object Object]`，`code`/`details` 全部丢失。
 * 因此结构化错误统一编码进 `Error.message`（带唯一 marker），preload 解码后再
 * 以 plain object 返回给 renderer（普通返回值可以完整穿过 contextBridge）。
 */

export const IPC_ERROR_MARKER = '__BIZGRAPH_IPC_ERROR__:'

export interface IpcErrorPayload {
  code: string
  message: string
  details?: unknown
  [key: string]: unknown
}

/** 失败信封：preload 在业务错误时返回它（而不是 reject），保证结构不被桥接层吞掉。 */
export interface IpcErrorResult {
  ok: false
  error: IpcErrorPayload
}

export function isIpcErrorResult(value: unknown): value is IpcErrorResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: unknown }).error !== null
  )
}

export function encodeIpcError(payload: IpcErrorPayload): string {
  return `${IPC_ERROR_MARKER}${JSON.stringify(payload)}`
}

/**
 * 从 Electron 包装后的 message 里取出结构化错误。
 * message 可能是 `Error invoking remote method 'agent:x': <encoded>`。
 */
export function decodeIpcError(message: unknown): IpcErrorPayload | null {
  if (typeof message !== 'string') return null
  const index = message.indexOf(IPC_ERROR_MARKER)
  if (index < 0) return null
  const raw = message.slice(index + IPC_ERROR_MARKER.length)
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<IpcErrorPayload>
    if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null
    return candidate as IpcErrorPayload
  } catch {
    return null
  }
}
