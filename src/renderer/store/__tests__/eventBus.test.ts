import { describe, it, expect, vi, afterEach } from 'vitest'
import { eventBus, Events } from '../eventBus'

describe('eventBus', () => {
  afterEach(() => {
    eventBus.clear()
  })

  it('emits events to subscribed handlers', () => {
    const handler = vi.fn()
    eventBus.on(Events.NODE_SELECTED, handler)
    eventBus.emit(Events.NODE_SELECTED, 'node-1')
    expect(handler).toHaveBeenCalledWith('node-1')
  })

  it('supports multiple handlers for the same event', () => {
    const h1 = vi.fn()
    const h2 = vi.fn()
    eventBus.on(Events.NODE_SELECTED, h1)
    eventBus.on(Events.NODE_SELECTED, h2)
    eventBus.emit(Events.NODE_SELECTED, 'node-1')
    expect(h1).toHaveBeenCalled()
    expect(h2).toHaveBeenCalled()
  })

  it('unsubscribes when cleanup function is called', () => {
    const handler = vi.fn()
    const cleanup = eventBus.on(Events.NODE_SELECTED, handler)
    cleanup()
    eventBus.emit(Events.NODE_SELECTED, 'node-1')
    expect(handler).not.toHaveBeenCalled()
  })

  it('offAll removes all handlers for an event', () => {
    const handler = vi.fn()
    eventBus.on(Events.NODE_SELECTED, handler)
    eventBus.offAll(Events.NODE_SELECTED)
    eventBus.emit(Events.NODE_SELECTED, 'node-1')
    expect(handler).not.toHaveBeenCalled()
  })

  it('clear removes all handlers', () => {
    const handler = vi.fn()
    eventBus.on(Events.NODE_SELECTED, handler)
    eventBus.clear()
    eventBus.emit(Events.NODE_SELECTED, 'node-1')
    expect(handler).not.toHaveBeenCalled()
  })

  it('does not throw when emitting without subscribers', () => {
    expect(() => eventBus.emit(Events.NODE_SELECTED, 'node-1')).not.toThrow()
  })

  it('continues emitting after one handler throws', () => {
    const good = vi.fn()
    const bad = vi.fn().mockImplementation(() => {
      throw new Error('oops')
    })
    eventBus.on(Events.NODE_SELECTED, bad)
    eventBus.on(Events.NODE_SELECTED, good)
    eventBus.emit(Events.NODE_SELECTED, 'node-1')
    expect(good).toHaveBeenCalledWith('node-1')
  })
})
