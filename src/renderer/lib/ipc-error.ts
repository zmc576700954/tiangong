/**
 * renderer 侧的 IPC 错误还原。
 *
 * 主进程把结构化错误编码进 `Error.message`（`__BIZGRAPH_IPC_ERROR__:` + JSON），
 * 只有 preload 的 `STRUCTURED_ERROR_CHANNELS` 会把它解成 `{ok:false,error}`。
 * 其余通道（例如 `graph:initFromProject`）reject 出来的是**带 marker 的 message**：
 * 直接 `String(err)` 上屏就是把 `__BIZGRAPH_IPC_ERROR__:{...}` 甩给用户。
 *
 * 这里用同一份 `@shared/ipc-error` 解码，拿回 `code / message / details`，
 * 让界面既能显示人话，也能读到 `details.decision` 这类结构化上下文。
 */

import { decodeIpcError } from '@shared/ipc-error'

export interface RendererIpcError {
  code: string
  message: string
  details?: unknown
}

export function readIpcError(err: unknown): RendererIpcError {
  const raw = err instanceof Error ? err.message : String(err)
  const decoded = decodeIpcError(raw)
  if (decoded) {
    return { code: decoded.code, message: decoded.message, details: decoded.details }
  }
  // 未编码的裸错误：去掉 Electron 自动加的 `Error invoking remote method 'x': ` 前缀。
  return {
    code: 'IPC_HANDLER_ERROR',
    message: raw.replace(/^Error invoking remote method '[^']*': /, ''),
  }
}

/** `details.decision` 的窄化读法（导入查重拒绝载荷）。 */
export function readImportRejectionDetail(details: unknown): {
  action?: string
  step?: string
  reason?: string
} | null {
  if (typeof details !== 'object' || details === null) return null
  const decision = (details as { decision?: unknown }).decision
  if (typeof decision !== 'object' || decision === null) return null
  const d = decision as { action?: unknown; step?: unknown; reason?: unknown }
  return {
    action: typeof d.action === 'string' ? d.action : undefined,
    step: typeof d.step === 'string' ? d.step : undefined,
    reason: typeof d.reason === 'string' ? d.reason : undefined,
  }
}
