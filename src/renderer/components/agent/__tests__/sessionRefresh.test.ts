/**
 * B1：同会话 turn 结束/审批解决后必须触发徽标刷新。
 */

import { describe, expect, it } from 'vitest'
import { shouldRefreshSessionState } from '../sessionRefresh'

describe('shouldRefreshSessionState (B1)', () => {
  it('turn 收口与审批解决事件触发刷新', () => {
    for (const type of [
      'turn.completed',
      'turn.failed',
      'turn.cancelled',
      'run.completed',
      'run.failed',
      'run.interrupted',
      'approval.resolved',
      'process.reclaimed',
    ]) {
      expect(shouldRefreshSessionState(type)).toBe(true)
    }
  })

  it('流式增量事件不触发无意义的重复查询', () => {
    for (const type of ['message.delta', 'reasoning.delta', 'tool.executing', 'usage.updated', undefined]) {
      expect(shouldRefreshSessionState(type)).toBe(false)
    }
  })
})
