/**
 * renderer 侧解包 preload 的结构化错误信封。
 *
 * preload 对 agent 写类通道的失败返回 `{ok:false, error:{code,message,details}}`
 * （plain object，能完整穿过 contextBridge）。这里把它还原成同 realm 的 Error，
 * 并把 code/details 挂到 Error 上，供调用方 catch 分支读取。
 */
import { isIpcErrorResult } from '@shared/ipc-error'

export interface IpcDomainError extends Error {
  code: string
  details?: unknown
}

export class IpcCallError extends Error implements IpcDomainError {
  readonly code: string
  readonly details?: unknown

  constructor(payload: { code: string; message: string; details?: unknown }) {
    super(payload.message)
    this.name = 'IpcCallError'
    this.code = payload.code
    this.details = payload.details
    Object.setPrototypeOf(this, IpcCallError.prototype)
  }
}

/** 成功原样返回；失败抛同 realm 的 IpcCallError（code/message 均保留）。 */
export function unwrapIpcResult<T>(result: unknown): T {
  if (isIpcErrorResult(result)) {
    throw new IpcCallError(result.error)
  }
  return result as T
}
