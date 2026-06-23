/**
 * 节点类型注册表 — 主进程专用
 *
 * 从 @shared/types/graph.ts 迁移而来，
 * 共享类型文件不应包含运行时逻辑（Map, class 实例化等）。
 */

import type { NodeTypeConfig, NodeType, NodeStatus } from '@shared/types'
import type { NodeTypeBehavior } from '../types/node-behavior'
import { NODE_STATUS_TRANSITIONS } from '@shared/types'

export type { NodeTypeConfig } from '@shared/types'
export type { NodeTypeBehavior } from '../types/node-behavior'

class NodeTypeRegistry {
  private types = new Map<string, NodeTypeConfig>()

  constructor() {
    const builtin: NodeTypeConfig[] = [
      { type: 'project', label: '项目根节点', defaultStatus: 'confirmed', allowedChildTypes: ['module'] },
      { type: 'module', label: '业务模块', defaultStatus: 'draft', allowedParentTypes: ['project'], allowedChildTypes: ['process'] },
      { type: 'process', label: '业务流程', defaultStatus: 'draft', allowedParentTypes: ['module'], allowedChildTypes: ['feature', 'bug'] },
      { type: 'feature', label: '功能点', defaultStatus: 'placeholder', allowedParentTypes: ['process'] },
      { type: 'bug', label: 'BUG点', defaultStatus: 'draft', allowedParentTypes: ['process'] },
    ]
    for (const config of builtin) {
      this.types.set(config.type, config)
    }
  }

  register(config: NodeTypeConfig): void { this.types.set(config.type, config) }
  get(type: string): NodeTypeConfig | undefined { return this.types.get(type) }
  listTypes(): string[] { return Array.from(this.types.keys()) }
  listConfigs(): NodeTypeConfig[] { return Array.from(this.types.values()) }
  has(type: string): boolean { return this.types.has(type) }

  validateParentChild(parentType: string, childType: string): boolean {
    const parent = this.types.get(parentType)
    const child = this.types.get(childType)
    if (!parent || !child) return false
    if (parent.allowedChildTypes && !parent.allowedChildTypes.includes(childType)) return false
    if (child.allowedParentTypes && !child.allowedParentTypes.includes(parentType)) return false
    return true
  }

  validateStatusTransition(nodeType: NodeType, from: NodeStatus, to: NodeStatus): boolean {
    if (from === to) return true
    const transitions = NODE_STATUS_TRANSITIONS[nodeType]
    if (!transitions) return false
    return transitions.some((t) => t.from === from && t.to === to)
  }

  getBehavior(type: string): NodeTypeBehavior | undefined {
    const behavior = this.types.get(type)?.behavior
    return behavior as NodeTypeBehavior | undefined
  }

  attachBehavior(type: string, behavior: Partial<NodeTypeBehavior>): void {
    const config = this.types.get(type)
    if (!config) throw new Error(`Cannot attach behavior to unknown node type: ${type}`)
    const existingBehavior = (config.behavior ?? {}) as Partial<NodeTypeBehavior>
    config.behavior = { ...existingBehavior, ...behavior }
  }
}

export const nodeTypeRegistry = new NodeTypeRegistry()
