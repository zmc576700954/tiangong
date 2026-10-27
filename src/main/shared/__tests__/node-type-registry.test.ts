import { describe, it, expect } from 'vitest'
import { nodeTypeRegistry, BUILTIN_NODE_TYPES } from '../node-type-registry'

describe('nodeTypeRegistry', () => {
  it('has built-in types', () => {
    const types = nodeTypeRegistry.listTypes()
    expect(types).toContain('project')
    expect(types).toContain('module')
    expect(types).toContain('process')
    expect(types).toContain('feature')
    expect(types).toContain('bug')
    expect(types).toContain('wiki-page')
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
    expect(configs.length).toBeGreaterThanOrEqual(6)
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
    expect(nodeTypeRegistry.validateParentChild('module', 'wiki-page')).toBe(true)
    expect(nodeTypeRegistry.validateParentChild('wiki-page', 'wiki-page')).toBe(true)
  })

  it('validateParentChild returns false for invalid parent-child', () => {
    expect(nodeTypeRegistry.validateParentChild('feature', 'module')).toBe(false)
    expect(nodeTypeRegistry.validateParentChild('bug', 'process')).toBe(false)
  })

  it('validateParentChild returns false for unknown types', () => {
    expect(nodeTypeRegistry.validateParentChild('unknown', 'module')).toBe(false)
    expect(nodeTypeRegistry.validateParentChild('module', 'unknown')).toBe(false)
  })

  it('module cannot have feature children', () => {
    expect(nodeTypeRegistry.validateParentChild('module', 'feature')).toBe(false)
  })

  it('feature can have bug children', () => {
    expect(nodeTypeRegistry.validateParentChild('feature', 'bug')).toBe(true)
  })

  it('bug cannot have any children', () => {
    expect(nodeTypeRegistry.validateParentChild('bug', 'feature')).toBe(false)
  })

  /**
   * 下面两条用「探针类型」把**父侧**检查单独拎出来：
   * 探针的 allowedParentTypes 明确允许该父节点 → 子侧必然放行，
   * 所以结果为 false 只能来自父侧的 allowedChildTypes。
   * 没有它们的话，删掉 feature / bug 的 allowedChildTypes 这一行，
   * 整套用例仍然全绿（子侧照样把非法父子关系拒掉）。
   */
  it('bug rejects a child whose allowedParentTypes permits bug', () => {
    nodeTypeRegistry.register({
      type: 'bug-child-probe',
      label: 'Bug Child Probe',
      defaultStatus: 'draft',
      allowedParentTypes: ['bug'],
    })
    expect(nodeTypeRegistry.validateParentChild('bug', 'bug-child-probe')).toBe(false)
  })

  it('feature rejects a child whose allowedParentTypes permits feature', () => {
    nodeTypeRegistry.register({
      type: 'feature-child-probe',
      label: 'Feature Child Probe',
      defaultStatus: 'draft',
      allowedParentTypes: ['feature'],
    })
    expect(nodeTypeRegistry.validateParentChild('feature', 'feature-child-probe')).toBe(false)
  })

  /**
   * 归一化：注册时没写 allowedChildTypes = 没有子节点。
   * 没有这条，校验器会放行任意子节点，而渲染端菜单的 `?? []` 一个都不给——
   * 两套真相。
   */
  it('a type registered without allowedChildTypes rejects every child', () => {
    nodeTypeRegistry.register({
      type: 'childless-parent',
      label: 'Childless Parent',
      defaultStatus: 'draft',
      allowedParentTypes: ['process'],
    })
    nodeTypeRegistry.register({
      type: 'childless-child',
      label: 'Childless Child',
      defaultStatus: 'draft',
      allowedParentTypes: ['childless-parent'],
    })
    expect(nodeTypeRegistry.validateParentChild('childless-parent', 'childless-child')).toBe(false)
  })

  /**
   * 内置规则表必须显式声明 allowedChildTypes。
   * 归一化之后「没写」和「写了空数组」在运行期等价，所以这条断言守的是
   * 「规范表本身不许留空」——把这两行从表里删掉，用例会红。
   */
  it('every builtin type explicitly declares allowedChildTypes', () => {
    for (const config of BUILTIN_NODE_TYPES) {
      expect(config.allowedChildTypes, `${config.type} must declare allowedChildTypes`).toBeDefined()
    }
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
      onCreate: async () => {},
    })
    const behavior = nodeTypeRegistry.getBehavior('behavior-test')
    expect(behavior).toBeDefined()
    expect(behavior?.onCreate).toBeDefined()
  })

  it('attachBehavior throws for unknown type', () => {
    expect(() => nodeTypeRegistry.attachBehavior('nonexistent', {})).toThrow()
  })
})
