import { describe, it, expect } from 'vitest'
import { AdapterHealthMonitor } from '../adapter-health-monitor'

describe('AdapterHealthMonitor', () => {
  it('records successful call', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('claude-code', true, 500)
    const health = monitor.getHealth('claude-code')
    expect(health).toBeDefined()
    expect(health!.metrics.totalCalls).toBe(1)
    expect(health!.metrics.successCalls).toBe(1)
    expect(health!.metrics.failedCalls).toBe(0)
  })

  it('records failed call with error message', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('codex', false, 1000, 'timeout')
    const health = monitor.getHealth('codex')
    expect(health!.metrics.failedCalls).toBe(1)
    expect(health!.metrics.recentErrors).toContain('timeout')
  })

  it('caps recent errors at 5', () => {
    const monitor = new AdapterHealthMonitor()
    for (let i = 0; i < 7; i++) {
      monitor.recordCall('opencode', false, 100, `error-${i}`)
    }
    const health = monitor.getHealth('opencode')
    expect(health!.metrics.recentErrors).toHaveLength(5)
    expect(health!.metrics.recentErrors[0]).toBe('error-2')
  })

  it('returns healthy status for good metrics', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('claude-code', true, 500)
    const health = monitor.getHealth('claude-code')
    expect(health!.status).toBe('healthy')
    expect(health!.successRate).toBe(100)
  })

  it('returns degraded status for mixed metrics', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('codex', true, 500)
    monitor.recordCall('codex', false, 500)
    const health = monitor.getHealth('codex')
    expect(health!.status).toBe('degraded')
    expect(health!.successRate).toBe(50)
  })

  it('returns unhealthy status for poor metrics', () => {
    const monitor = new AdapterHealthMonitor()
    for (let i = 0; i < 5; i++) {
      monitor.recordCall('opencode', false, 100)
    }
    const health = monitor.getHealth('opencode')
    expect(health!.status).toBe('unhealthy')
  })

  it('returns undefined for unknown adapter', () => {
    const monitor = new AdapterHealthMonitor()
    expect(monitor.getHealth('unknown')).toBeUndefined()
  })

  it('getHealthiestAdapter returns the healthiest adapter', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('claude-code', true, 500)
    monitor.recordCall('codex', false, 500)
    monitor.recordCall('opencode', true, 500)
    const healthiest = monitor.getHealthiestAdapter(['claude-code', 'codex', 'opencode'])
    expect(healthiest).toBe('claude-code')
  })

  it('getHealthiestAdapter filters unknown adapters', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('claude-code', true, 500)
    const healthiest = monitor.getHealthiestAdapter(['claude-code', 'never-used'])
    expect(healthiest).toBe('claude-code')
  })

  it('getHealthiestAdapter returns undefined when no candidates are recorded', () => {
    const monitor = new AdapterHealthMonitor()
    const healthiest = monitor.getHealthiestAdapter(['a', 'b'])
    expect(healthiest).toBeUndefined()
  })

  it('cleanupStaleMetrics removes old metrics', async () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('claude-code', true, 500)
    await new Promise((resolve) => setTimeout(resolve, 2))
    monitor.cleanupStaleMetrics(0)
    expect(monitor.getHealth('claude-code')).toBeUndefined()
  })

  it('resetMetrics clears specific adapter metrics', () => {
    const monitor = new AdapterHealthMonitor()
    monitor.recordCall('claude-code', true, 500)
    monitor.resetMetrics('claude-code')
    expect(monitor.getHealth('claude-code')).toBeUndefined()
  })
})
