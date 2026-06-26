import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerModeHandlers } from '../mode'
import { IpcError } from '../../errors'
import type { TypedHandle } from '../utils'

vi.mock('../../agent/mode-manager', () => ({
  getModeManager: vi.fn().mockReturnValue({
    getMode: vi.fn().mockReturnValue('general'),
    setMode: vi.fn(),
    getAvailableModes: vi.fn().mockReturnValue([]),
  }),
}))

describe('registerModeHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const typedHandle = vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    handlers[channel] = handler
  }) as unknown as TypedHandle

  beforeEach(() => {
    handlers = {}
    vi.clearAllMocks()
    registerModeHandlers(typedHandle)
  })

  it('registers expected handlers', () => {
    expect(handlers['mode:getCurrent']).toBeDefined()
    expect(handlers['mode:setCurrent']).toBeDefined()
    expect(handlers['mode:getAvailable']).toBeDefined()
  })

  it('mode:getCurrent validates projectId', async () => {
    await expect(handlers['mode:getCurrent'](null as never, '')).rejects.toThrow(IpcError)
  })

  it('mode:setCurrent rejects invalid mode', async () => {
    await expect(handlers['mode:setCurrent'](null as never, 'proj-1', 'invalid')).rejects.toThrow(IpcError)
  })

  it('mode:setCurrent accepts valid mode', async () => {
    await expect(handlers['mode:setCurrent'](null as never, 'proj-1', 'security')).resolves.toBeUndefined()
  })
})
