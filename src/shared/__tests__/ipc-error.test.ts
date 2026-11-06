import { describe, expect, it } from 'vitest'
import { decodeIpcError, encodeIpcError, isIpcErrorResult } from '../ipc-error'

describe('IPC 结构化错误编解码（P1-2）', () => {
  it('encode → decode 保留 code / message / details', () => {
    const payload = { code: 'AGENT_SESSION_RESTORE_FAILED', message: '无法恢复：原因', details: { sessionId: 's-1' } }
    expect(decodeIpcError(encodeIpcError(payload))).toEqual(payload)
  })

  it('能从 Electron 包装后的 message 中解出结构化错误', () => {
    const payload = { code: 'APPROVAL_STALE', message: '该审批所属轮次已结束' }
    const wrapped = `Error invoking remote method 'agent:resolveApproval': ${encodeIpcError(payload)}`
    expect(decodeIpcError(wrapped)).toEqual(payload)
  })

  it('普通错误 / 空值不会被误判', () => {
    expect(decodeIpcError('Error invoking remote method: [object Object]')).toBeNull()
    expect(decodeIpcError(null)).toBeNull()
    expect(decodeIpcError('__BIZGRAPH_IPC_ERROR__:{bad json')).toBeNull()
    expect(decodeIpcError('__BIZGRAPH_IPC_ERROR__:{"code":1}')).toBeNull()
  })

  it('失败信封识别', () => {
    expect(isIpcErrorResult({ ok: false, error: { code: 'X', message: 'm' } })).toBe(true)
    expect(isIpcErrorResult({ ok: true, value: 1 })).toBe(false)
    expect(isIpcErrorResult(undefined)).toBe(false)
  })
})
