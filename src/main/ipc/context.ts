import { AsyncLocalStorage } from 'node:async_hooks'
import { IpcError, ErrorCode } from '../errors'

export interface IpcContext {
  senderId: number
}

export const ipcContext = new AsyncLocalStorage<IpcContext>()

export function getIpcContext(): IpcContext {
  const ctx = ipcContext.getStore()
  if (!ctx) throw new IpcError('IpcContext not available outside an IPC handler', ErrorCode.IPC_HANDLER_ERROR)
  return ctx
}
