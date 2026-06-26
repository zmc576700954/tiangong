import { describe, it, expect } from 'vitest'
import { ADAPTER_REGISTRY, getFilteredRegistry, buildMarketplaceItems } from '../registry'
import { AdapterCapability } from '@shared/types'

describe('registry', () => {
  it('contains core adapters', () => {
    const names = ADAPTER_REGISTRY.map((d) => d.name)
    expect(names).toContain('claude-code')
    expect(names).toContain('codex')
    expect(names).toContain('opencode')
    expect(names).toContain('mcp')
  })

  it('every adapter has required fields', () => {
    for (const adapter of ADAPTER_REGISTRY) {
      expect(adapter.name).toBeTruthy()
      expect(adapter.displayName).toBeTruthy()
      expect(adapter.type).toMatch(/^(cli|sdk|api)$/)
      expect(adapter.adapterClass).toBeDefined()
      expect(adapter.homepage).toBeDefined()
    }
  })

  it('getFilteredRegistry returns all on current platform when no platform filter', () => {
    const filtered = getFilteredRegistry()
    expect(filtered.length).toBeGreaterThanOrEqual(ADAPTER_REGISTRY.filter((d) => !d.platforms).length)
  })

  it('buildMarketplaceItems excludes hidden adapters', async () => {
    const items = await buildMarketplaceItems({})
    expect(items.some((i) => i.name === 'mindmap-internal')).toBe(false)
  })

  it('buildMarketplaceItems marks installed adapters', async () => {
    const items = await buildMarketplaceItems({ 'claude-code': true })
    const claude = items.find((i) => i.name === 'claude-code')
    expect(claude?.installed).toBe(true)
  })

  it('claude-code has expected capabilities', () => {
    const claude = ADAPTER_REGISTRY.find((d) => d.name === 'claude-code')
    expect(claude?.capabilities).toContain(AdapterCapability.Resume)
    expect(claude?.capabilities).toContain(AdapterCapability.Tools)
    expect(claude?.fallbackTo).toBe('mcp')
    expect(claude?.contextWindow).toBe(200_000)
  })
})
