import { describe, it, expect } from 'vitest'
import { nodeTypeRegistry } from '../node-type-registry'

describe('nodeTypeRegistry', () => {
  it('has built-in types', () => {
    const types = nodeTypeRegistry.listTypes()
    expect(types).toContain('project')
    expect(types).toContain('module')
    expect(types).toContain('process')
    expect(types).toContain('feature')
    expect(types).toContain('bug')
  })

  it('get returns config for known type', () => {
    const config = nodeTypeRegistry.get('module')
    expect(config).toBeDefined()
    expect(config?.label).toBe('业务模块')
    expect(config?.defaultStatus).toBe('draft')
  })

  it('get returns undefined for unknown type', () => {
    expect(nodeTypeRegistry.get('unknown')).toBeUndefined()
  })

  it('has returns true for known type', () => {
    expect(nodeTypeRegistry.has('feature')).toBe(true)
  })

  it('has returns false for unknown type', () => {
    expect(nodeTypeRegistry.has('unknown')).toBe(false)
  })

  it('listConfigs returns all configs', () => {
    const configs = nodeTypeRegistry.listConfigs()
    expect(configs.length).toBeGreaterThanOrEqual(5)
  })

  it('register adds a new type', () => {
    nodeTypeRegistry.register({
      type: 'custom-test-type',
      label: 'Custom',
      defaultStatus: 'draft',
    })
    expect(nodeTypeRegistry.has('custom-test-type')).toBe(true)
    expect(nodeTypeRegistry.get('custom-test-type')?.label).toBe('Custom')
  })

  it('validateParentChild returns true for valid parent-child', () => {
    expect(nodeTypeRegistry.validateParentChild('project', 'module')).toBe(true)
    expect(nodeTypeRegistry.validateParentChild('module', 'process')).toBe(true)
    expect(nodeTypeRegistry.validateParentChild('process', 'feature')).toBe(true)
    expect(nodeTypeRegistry.validateParentChild('process', 'bug')).toBe(true)
  })

  it('validateParentChild returns false for invalid parent-child', () => {
    expect(nodeTypeRegistry.validateParentChild('feature', 'module')).toBe(false)
    expect(nodeTypeRegistry.validateParentChild('bug', 'process')).toBe(false)
  })

  it('validateParentChild returns false for unknown types', () => {
    expect(nodeTypeRegistry.validateParentChild('unknown', 'module')).toBe(false)
    expect(nodeTypeRegistry.validateParentChild('module', 'unknown')).toBe(false)
  })

  it('validateStatusTransition returns true for same status', () => {
    expect(nodeTypeRegistry.validateStatusTransition('feature', 'draft', 'draft')).toBe(true)
  })

  it('validateStatusTransition returns true for valid transition', () => {
    expect(nodeTypeRegistry.validateStatusTransition('feature', 'placeholder', 'developing')).toBe(true)
    expect(nodeTypeRegistry.validateStatusTransition('feature', 'draft', 'confirmed')).toBe(true)
  })

  it('validateStatusTransition returns false for invalid transition', () => {
    expect(nodeTypeRegistry.validateStatusTransition('feature', 'published', 'draft')).toBe(false)
  })

  it('getBehavior returns undefined when no behavior attached', () => {
    expect(nodeTypeRegistry.getBehavior('feature')).toBeUndefined()
  })

  it('attachBehavior sets behavior on a type', () => {
    nodeTypeRegistry.register({
      type: 'behavior-test',
      label: 'Behavior Test',
      defaultStatus: 'draft',
    })
    nodeTypeRegistry.attachBehavior('behavior-test', {
      canHaveBugs: true,
    })
    const behavior = nodeTypeRegistry.getBehavior('behavior-test')
    expect(behavior).toBeDefined()
    expect(behavior?.canHaveBugs).toBe(true)
  })

  it('attachBehavior throws for unknown type', () => {
    expect(() => nodeTypeRegistry.attachBehavior('nonexistent', {})).toThrow()
  })
})
