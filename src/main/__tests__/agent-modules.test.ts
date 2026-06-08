import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdapterRegistry } from '../agent/adapter-registry'
import { SessionRouter } from '../agent/session-router'
import { OutputBroadcaster } from '../agent/output-broadcaster'
import { SessionNotFoundError, AdapterError } from '../errors'
import type { AgentAdapter, AgentOutput } from '@shared/types'

function createMockAdapter(name: string, installed = true): AgentAdapter {
  return {
    name,
    version: '1.0.0',
    checkInstalled: vi.fn().mockResolvedValue(installed),
    startSession: vi.fn(),
    sendCommand: vi.fn(),
    onOutput: vi.fn(),
    offOutput: vi.fn(),
    terminateSession: vi.fn(),
    setResolvedContexts: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as AgentAdapter
}

// ==================== AdapterRegistry ====================
describe('AdapterRegistry', () => {
  let registry: AdapterRegistry

  beforeEach(() => {
    registry = new AdapterRegistry()
  })

  it('注册并获取适配器', () => {
    const adapter = createMockAdapter('claude-code')
    registry.register(adapter)
    expect(registry.get('claude-code')).toBe(adapter)
  })

  it('获取不存在的适配器 → undefined', () => {
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('list 返回所有已注册适配器', () => {
    const a1 = createMockAdapter('a1')
    const a2 = createMockAdapter('a2')
    registry.register(a1)
    registry.register(a2)
    expect(registry.list()).toHaveLength(2)
  })

  it('同名适配器覆盖注册', () => {
    const a1 = createMockAdapter('adapter')
    const a2 = createMockAdapter('adapter')
    registry.register(a1)
    registry.register(a2)
    expect(registry.get('adapter')).toBe(a2)
    expect(registry.list()).toHaveLength(1)
  })

  it('checkAllInstalled 返回安装状态', async () => {
    registry.register(createMockAdapter('a1', true))
    registry.register(createMockAdapter('a2', false))
    const results = await registry.checkAllInstalled()
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ name: 'a1', version: '1.0.0', installed: true })
    expect(results[1]).toEqual({ name: 'a2', version: '1.0.0', installed: false })
  })

  it('空注册表 checkAllInstalled → 空数组', async () => {
    const results = await registry.checkAllInstalled()
    expect(results).toEqual([])
  })
})

// ==================== SessionRouter ====================
describe('SessionRouter', () => {
  let registry: AdapterRegistry
  let router: SessionRouter
  let adapter: AgentAdapter

  beforeEach(() => {
    registry = new AdapterRegistry()
    adapter = createMockAdapter('claude-code')
    registry.register(adapter)
    router = new SessionRouter(registry)
  })

  it('bind + resolve → 返回正确适配器', () => {
    router.bind('session1', 'claude-code')
    expect(router.resolve('session1')).toBe(adapter)
  })

  it('resolve 未绑定的 session → SessionNotFoundError', () => {
    expect(() => router.resolve('unknown')).toThrow(SessionNotFoundError)
  })

  it('resolve 绑定了已注销的适配器 → AdapterError', () => {
    router.bind('session1', 'nonexistent-adapter')
    expect(() => router.resolve('session1')).toThrow(AdapterError)
  })

  it('unbind 后 resolve → SessionNotFoundError', () => {
    router.bind('session1', 'claude-code')
    router.unbind('session1')
    expect(() => router.resolve('session1')).toThrow(SessionNotFoundError)
  })

  it('getAdapterName → 返回适配器名', () => {
    router.bind('s1', 'claude-code')
    expect(router.getAdapterName('s1')).toBe('claude-code')
    expect(router.getAdapterName('unknown')).toBeUndefined()
  })

  it('fallback 信息管理', () => {
    router.bind('s1', 'mcp', 'codex')
    const info = router.getFallbackInfo('s1')
    expect(info).toEqual({ original: 'codex', actual: 'mcp' })
    expect(router.getOriginalAdapterName('s1')).toBe('codex')
  })

  it('无 fallback → undefined', () => {
    router.bind('s1', 'claude-code')
    expect(router.getFallbackInfo('s1')).toBeUndefined()
    expect(router.getOriginalAdapterName('s1')).toBeUndefined()
  })

  it('同名 original 和 actual → 不记录 fallback', () => {
    router.bind('s1', 'claude-code', 'claude-code')
    expect(router.getFallbackInfo('s1')).toBeUndefined()
  })

  it('unbind 同时清理 fallback', () => {
    router.bind('s1', 'mcp', 'codex')
    router.unbind('s1')
    expect(router.getFallbackInfo('s1')).toBeUndefined()
  })

  it('getActiveSessionIds → 返回所有活跃会话', () => {
    router.bind('s1', 'claude-code')
    router.bind('s2', 'claude-code')
    const ids = router.getActiveSessionIds()
    expect(ids).toContain('s1')
    expect(ids).toContain('s2')
    expect(ids).toHaveLength(2)
  })
})

// ==================== OutputBroadcaster ====================
describe('OutputBroadcaster', () => {
  let broadcaster: OutputBroadcaster

  beforeEach(() => {
    broadcaster = new OutputBroadcaster()
  })

  it('onBroadcast + broadcast → handler 被调用', () => {
    const handler = vi.fn()
    broadcaster.onBroadcast(handler)

    const output: AgentOutput = { type: 'stdout', data: 'hello', timestamp: 1 }
    broadcaster.broadcast('claude-code', output)

    expect(handler).toHaveBeenCalledWith('claude-code', output)
  })

  it('多个 handler 都被调用', () => {
    const h1 = vi.fn()
    const h2 = vi.fn()
    broadcaster.onBroadcast(h1)
    broadcaster.onBroadcast(h2)

    const output: AgentOutput = { type: 'stdout', data: 'test', timestamp: 1 }
    broadcaster.broadcast('adapter', output)

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
  })

  it('offBroadcast 后不再调用', () => {
    const handler = vi.fn()
    broadcaster.onBroadcast(handler)
    broadcaster.offBroadcast(handler)

    broadcaster.broadcast('adapter', { type: 'stdout', data: 'x', timestamp: 1 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('handler 抛异常不影响其他 handler', () => {
    const badHandler = vi.fn().mockImplementation(() => { throw new Error('boom') })
    const goodHandler = vi.fn()

    broadcaster.onBroadcast(badHandler)
    broadcaster.onBroadcast(goodHandler)

    // 不应抛出
    broadcaster.broadcast('adapter', { type: 'stdout', data: 'x', timestamp: 1 })
    expect(badHandler).toHaveBeenCalled()
    expect(goodHandler).toHaveBeenCalled()
  })

  it('无 handler 时 broadcast 不抛错', () => {
    expect(() => {
      broadcaster.broadcast('adapter', { type: 'stdout', data: 'x', timestamp: 1 })
    }).not.toThrow()
  })
})
