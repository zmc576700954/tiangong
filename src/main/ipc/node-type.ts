/**
 * Node Type IPC Handlers
 *
 * 把主进程的节点类型注册表暴露给渲染端，让「哪些类型能挂在哪些类型下」
 * 这条规则只有一个权威来源（nodeTypeRegistry），渲染端不再自带一份副本。
 */

import type { TypedHandle } from './utils'
import { nodeTypeRegistry } from '../shared/node-type-registry'

export function registerNodeTypeIpcHandlers(typedHandle: TypedHandle): void {
  typedHandle('nodeType:listConfigs', async () =>
    // behavior 字段含函数（NodeTypeBehavior），不可结构化克隆 —— 必须剥掉
    nodeTypeRegistry.listConfigs().map(({ behavior: _behavior, ...rest }) => rest),
  )
}
