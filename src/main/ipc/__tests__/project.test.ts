import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerProjectHandlers } from '../project'
import type { GraphService } from '../../services/graph-service'
import type { TypedHandle } from '../utils'

describe('registerProjectHandlers', () => {
  let handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const typedHandle = vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    handlers[channel] = handler
  }) as unknown as TypedHandle
  const graphService = {
    initFromProject: vi.fn().mockResolvedValue({
      onlineGraph: { id: 'g1' },
      devGraph: { id: 'g2' },
      modules: [],
    }),
  } as unknown as GraphService

  beforeEach(() => {
    handlers = {}
    vi.clearAllMocks()
    registerProjectHandlers(typedHandle, graphService)
  })

  it('registers project:scan handler', () => {
    expect(typedHandle).toHaveBeenCalledWith('project:scan', expect.any(Function))
  })

  it('registers graph:initFromProject handler', () => {
    expect(typedHandle).toHaveBeenCalledWith('graph:initFromProject', expect.any(Function))
  })
})
