/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P1-2 全链路：main 处理器 → Electron IPC（拒绝语义）→ preload 桥 → renderer。
 *
 * 与 ipcErrorBoundary.test.ts 的区别：这里不手工构造编码后的错误，而是
 * 让真实的 `createTypedHandle`（main 侧统一错误出口）真的抛错，再由
 * `ipcRenderer.invoke` 按 Electron 语义包装后交给真实 preload 逻辑，
 * 最后走 renderer 的 `unwrapIpcResult`。任何一环丢失结构都会让断言失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: any[]) => Promise<any>>(),
  invoke: vi.fn(),
  expose: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: mocks.expose },
}))

import { createTypedHandle } from '../../main/ipc/utils'
import { BizGraphError, ErrorCode, IpcError } from '../../main/errors'
import { AgentRuntimeError } from '../../main/agent/runtime/errors'
import { unwrapIpcResult, IpcCallError } from '../../renderer/lib/ipcResult'
import '../index'

/** 用真实 createTypedHandle 注册一个「必定抛错」的 handler，并模拟 Electron 的 invoke 语义。 */
function installFailing(channel: string, error: unknown): void {
  createTypedHandle({ handle: (c: string, fn: any) => mocks.handlers.set(c, fn) } as any)(
    channel,
    async () => {
      throw error
    },
  )
  mocks.invoke.mockImplementation(async (c: string, ...args: unknown[]) => {
    const handler = mocks.handlers.get(c)
    if (!handler) throw new Error(`no handler for ${c}`)
    try {
      return await handler({ sender: { id: 1 } }, ...args)
    } catch (err) {
      // Electron 真实行为：只保留 message，并加前缀
      throw new Error(`Error invoking remote method '${c}': ${(err as Error).message}`)
    }
  })
}

function exposedApi(): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const call = mocks.expose.mock.calls[0]
  expect(call?.[0]).toBe('electronAPI')
  return call[1] as Record<string, (...args: unknown[]) => Promise<unknown>>
}

function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected throw')
}

describe('全链路：main → preload → renderer（P1-2）', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.invoke.mockReset()
  })

  it('IpcError：renderer 拿到 code + message，且绝无 [object Object]', async () => {
    installFailing('agent:sendCommand', new IpcError('启动阶段无法执行命令', ErrorCode.IPC_HANDLER_ERROR))
    const raw = await exposedApi()['agent:sendCommand']('sess-1', {})

    expect(raw).toMatchObject({
      ok: false,
      error: { code: ErrorCode.IPC_HANDLER_ERROR, message: '启动阶段无法执行命令' },
    })

    const caught = capture(() => unwrapIpcResult(raw))
    expect(caught).toBeInstanceOf(IpcCallError)
    expect(caught).toMatchObject({ code: ErrorCode.IPC_HANDLER_ERROR, message: '启动阶段无法执行命令' })
    expect((caught as Error).message).not.toContain('[object Object]')
  })

  it('BizGraphError(AGENT_SESSION_RESTORE_FAILED)：code 不丢，renderer 可读', async () => {
    installFailing(
      'agent:startSession',
      new BizGraphError('无法恢复会话 sess-1：没有可续接的底层会话 id。新建会话可继续。', 'AGENT_SESSION_RESTORE_FAILED'),
    )
    const raw = await exposedApi()['agent:startSession'](null, {})

    expect(raw).toMatchObject({ ok: false, error: { code: 'AGENT_SESSION_RESTORE_FAILED' } })
    expect(() => unwrapIpcResult(raw)).toThrow(/没有可续接的底层会话 id/)
  })

  it('AgentRuntimeError(APPROVAL_STALE)：僵尸审批的拒绝理由能穿透到 renderer', async () => {
    installFailing(
      'agent:resolveApproval',
      new AgentRuntimeError(
        'APPROVAL_STALE',
        '该审批所属轮次已结束，批准不会执行（已自动置为 denied）。请重新发送命令以触发新的审批。',
      ),
    )
    const raw = await exposedApi()['agent:resolveApproval']({ approvalId: 'appr-1', decision: 'allow', argsHash: 'h' })

    expect(raw).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_STALE',
        message: '该审批所属轮次已结束，批准不会执行（已自动置为 denied）。请重新发送命令以触发新的审批。',
      },
    })
    expect(() => unwrapIpcResult(raw)).toThrow(/已自动置为 denied/)
  })
})
