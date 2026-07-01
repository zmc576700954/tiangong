import { describe, it, expect } from 'vitest'
import { ipcContext, getIpcContext } from '../context'

describe('getIpcContext', () => {
  it('throws when called outside IPC handler', () => {
    expect(() => getIpcContext()).toThrow('IpcContext not available')
  })

  it('returns context when inside AsyncLocalStorage context', async () => {
    const testCtx = { senderId: 42 }
    const result = await ipcContext.run(testCtx, async () => {
      return getIpcContext()
    })
    expect(result.senderId).toBe(42)
  })
})
