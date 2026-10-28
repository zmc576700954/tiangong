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

/**
 * 内置节点类型表 —— 节点层级规则的规范表（spec §4.6），唯一权威。
 *
 * 单独导出：测试要能直接断言「每条内置规则都显式声明了 allowedChildTypes」——
 * 缺字段原本在校验器里意味着「允许任意子节点」，那正是本任务要消除的缺陷；
 * 现在缺字段在注册时被归一化成 `[]`（一个子节点都不给），见下方 normalizeConfig。
 */
export const BUILTIN_NODE_TYPES: NodeTypeConfig[] = [
  { type: 'project', label: '项目根节点', defaultStatus: 'confirmed', allowedChildTypes: ['module'] },
  { type: 'module', label: '业务模块', defaultStatus: 'draft', allowedParentTypes: ['project'], allowedChildTypes: ['process', 'wiki-page'] },
  { type: 'process', label: '业务流程', defaultStatus: 'draft', allowedParentTypes: ['module'], allowedChildTypes: ['feature', 'bug', 'wiki-page'] },
  { type: 'feature', label: '功能点', defaultStatus: 'placeholder', allowedParentTypes: ['process'], allowedChildTypes: ['bug'] },
  { type: 'bug', label: 'BUG点', defaultStatus: 'draft', allowedParentTypes: ['process', 'feature'], allowedChildTypes: [] },
  {
    type: 'wiki-page',
    label: 'Wiki 页面',
    defaultStatus: 'confirmed',
    icon: 'book-open',
    color: '#a855f7',
    allowedParentTypes: ['project', 'module', 'process', 'wiki-page'],
    allowedChildTypes: ['wiki-page'],
    metadataSchema: {
      fields: {
        specialPage: { type: 'string', description: '特殊页面类型：index、log 或 community' },
        tags: { type: 'string[]', description: '页面标签列表' },
        createdBy: { type: 'string', description: '创建者标识' },
      },
    },
  },
]

/**
 * 归一化：`allowedChildTypes` 永远有值。
 *
 * 缺字段在校验器里原本意味着「允许任意子节点」，而渲染端菜单的 `?? []` 意味着
 * 「一个子节点都不给」——两套真相。统一成「缺省 = 没有子节点」。
 *
 * ⚠️ 只归一化 `allowedChildTypes`：`allowedParentTypes` **故意不归一化**，
 * 缺省仍是「允许任意父节点」（validateParentChild 里该字段不存在就放行）。
 * 两个字段的缺省语义是**相反**的——子类型表缺省 = 拒绝 / 父类型表缺省 = 允许——
 * 渲染端（Task 10 的拖拽重挂判定）必须原样镜像这个不对称。
 */
function normalizeConfig(config: NodeTypeConfig): NodeTypeConfig {
  return { ...config, allowedChildTypes: config.allowedChildTypes ?? [] }
}

class NodeTypeRegistry {
  private types = new Map<string, NodeTypeConfig>()

  constructor() {
    for (const config of BUILTIN_NODE_TYPES) {
      this.types.set(config.type, normalizeConfig(config))
    }
  }

  register(config: NodeTypeConfig): void { this.types.set(config.type, normalizeConfig(config)) }
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
