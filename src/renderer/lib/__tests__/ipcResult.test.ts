import { describe, expect, it } from 'vitest'
import { unwrapIpcResult, IpcCallError } from '../ipcResult'

describe('renderer 侧结构化错误解包（P1-2）', () => {
  it('成功返回值原样透传', () => {
    expect(unwrapIpcResult<{ sessionId: string }>({ sessionId: 's-1' })).toEqual({ sessionId: 's-1' })
    expect(unwrapIpcResult<void>(undefined)).toBeUndefined()
  })

  it('失败信封还原成同 realm 的 Error，code + message 均可读', () => {
    try {
      unwrapIpcResult({
        ok: false,
        error: {
          code: 'AGENT_SESSION_RESTORE_FAILED',
          message: '无法恢复会话 sess-1：没有可续接的底层会话 id。新建会话可继续。',
          details: { sessionId: 'sess-1' },
        },
      })
      expect.unreachable('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(IpcCallError)
      const e = err as IpcCallError
      expect(e.code).toBe('AGENT_SESSION_RESTORE_FAILED')
      expect(e.message).toContain('新建会话可继续')
      expect(e.details).toEqual({ sessionId: 'sess-1' })
      expect(String(e)).not.toContain('[object Object]')
    }
  })
})
