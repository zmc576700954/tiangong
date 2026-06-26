import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerSettingsHandlers } from '../settings'
import { IpcError } from '../../errors'
import type { TypedHandle } from '../utils'

describe('registerSettingsHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const typedHandle = vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    handlers[channel] = handler
  }) as unknown as TypedHandle

  beforeEach(() => {
    handlers = {}
    vi.clearAllMocks()
    registerSettingsHandlers(typedHandle)
  })

  it('registers expected handlers', () => {
    expect(handlers['settings:read']).toBeDefined()
    expect(handlers['settings:write']).toBeDefined()
    expect(handlers['settings:installCli']).toBeDefined()
    expect(handlers['settings:setContextWaterlineConfig']).toBeDefined()
  })

  it('settings:write validates settings object', async () => {
    await expect(handlers['settings:write'](null as never, null)).rejects.toThrow(IpcError)
  })

  it('settings:installCli rejects unknown tool name', async () => {
    await expect(handlers['settings:installCli'](null as never, 'unknown-tool')).rejects.toThrow(IpcError)
  })

  it('settings:setContextWaterlineConfig validates threshold range', async () => {
    await expect(handlers['settings:setContextWaterlineConfig'](null as never, { autoCompactThreshold: 1.5 })).rejects.toThrow(IpcError)
  })
})
