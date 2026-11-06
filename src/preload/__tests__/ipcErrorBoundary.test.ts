/**
 * P1-2 端到端（preload 边界）：main 抛出的结构化错误必须真的穿到 renderer，
 * 而不是被 Electron 压平成 `[object Object]`。
 *
 * 这里直接加载真实的 preload 入口（electron 以 mock 替换），从
 * `contextBridge.exposeInMainWorld` 拿到暴露给 renderer 的 API，模拟
 * `ipcRenderer.invoke` 的拒绝，断言返回值形态。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  expose: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, off: mocks.off },
  contextBridge: { exposeInMainWorld: mocks.expose },
}))

import { encodeIpcError } from '@shared/ipc-error'
import '../index'

function exposedApi(): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const call = mocks.expose.mock.calls[0]
  expect(call?.[0]).toBe('electronAPI')
  return call[1] as Record<string, (...args: unknown[]) => Promise<unknown>>
}

describe('preload 边界：结构化错误穿透（P1-2）', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('main 的结构化错误 → renderer 拿到 {code,message} 而不是 [object Object]', async () => {
    mocks.invoke.mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'agent:sendCommand': ${encodeIpcError({
          code: 'AGENT_SESSION_RESTORE_FAILED',
          message: '无法恢复会话 sess-1：没有可续接的底层会话 id。新建会话可继续。',
        })}`,
      ),
    )

    const result = await exposedApi()['agent:sendCommand']('sess-1', { description: 'x' })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'AGENT_SESSION_RESTORE_FAILED',
        message: '无法恢复会话 sess-1：没有可续接的底层会话 id。新建会话可继续。',
      },
    })
    expect(JSON.stringify(result)).not.toContain('[object Object]')
  })

  it('成功返回值保持原样（不改变既有调用契约）', async () => {
    mocks.invoke.mockResolvedValueOnce({ sessionId: 'sess-2' })
    const result = await exposedApi()['agent:startSession'](null, {})
    expect(result).toEqual({ sessionId: 'sess-2' })
  })

  it('非结构化裸错误降级为 IPC_HANDLER_ERROR，但 message 仍可读', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Error invoking remote method 'agent:sendCommand': boom"))
    const result = await exposedApi()['agent:sendCommand']('sess-1', {})
    expect(result).toEqual({ ok: false, error: { code: 'IPC_HANDLER_ERROR', message: 'boom' } })
  })

  it('未纳入信封的通道保持 reject 语义（避免大范围契约漂移）', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('nope'))
    await expect(exposedApi()['agent:getPendingApprovals']()).rejects.toThrow('nope')
  })
})
