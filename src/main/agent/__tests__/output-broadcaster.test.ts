import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentOutput } from '@shared/types'
import { OutputBroadcaster, type BroadcastPayload } from '../output-broadcaster'

describe('OutputBroadcaster', () => {
  let broadcaster: OutputBroadcaster

  beforeEach(() => {
    broadcaster = new OutputBroadcaster()
  })

  const output: AgentOutput = { type: 'stdout', data: 'hello', timestamp: Date.now() }

  it('broadcasts to registered handlers', () => {
    const handler = vi.fn()
    broadcaster.onBroadcast(handler)

    broadcaster.broadcast('claude-code', output, 'sess-1')

    expect(handler).toHaveBeenCalledTimes(1)
    const payload: BroadcastPayload = handler.mock.calls[0][0]
    expect(payload.adapterName).toBe('claude-code')
    expect(payload.sessionId).toBe('sess-1')
    expect(payload.output).toBe(output)
  })

  it('broadcasts without sessionId', () => {
    const handler = vi.fn()
    broadcaster.onBroadcast(handler)

    broadcaster.broadcast('codex', output)

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ adapterName: 'codex', sessionId: undefined }),
    )
  })

  it('does not call removed handlers', () => {
    const handler = vi.fn()
    broadcaster.onBroadcast(handler)
    broadcaster.offBroadcast(handler)

    broadcaster.broadcast('test', output)

    expect(handler).not.toHaveBeenCalled()
  })

  it('continues broadcasting after one handler throws', () => {
    const failingHandler = vi.fn(() => { throw new Error('boom') })
    const successHandler = vi.fn()

    broadcaster.onBroadcast(failingHandler)
    broadcaster.onBroadcast(successHandler)

    broadcaster.broadcast('test', output)

    expect(successHandler).toHaveBeenCalledTimes(1)
  })

  it('supports multiple handlers', () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    broadcaster.onBroadcast(handler1)
    broadcaster.onBroadcast(handler2)

    broadcaster.broadcast('test', output)

    expect(handler1).toHaveBeenCalledTimes(1)
    expect(handler2).toHaveBeenCalledTimes(1)
  })

  it('offBroadcast is idempotent for non-registered handler', () => {
    const handler = vi.fn()
    broadcaster.offBroadcast(handler) // should not throw
    broadcaster.broadcast('test', output)
    expect(handler).not.toHaveBeenCalled()
  })
})
