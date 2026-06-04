import { AsyncLocalStorage } from 'node:async_hooks'

export interface IpcContext {
  senderId: number
}

export const ipcContext = new AsyncLocalStorage<IpcContext>()

export function getIpcContext(): IpcContext {
  const ctx = ipcContext.getStore()
  if (!ctx) throw new Error('IpcContext not available outside an IPC handler')
  return ctx
}
