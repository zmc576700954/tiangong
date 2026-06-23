/**
 * Node Behavior Types — Main-process only
 *
 * NodeTypeBehavior contains function signatures that cannot be serialized
 * across IPC, so it must not live in shared types.
 */

import type { GraphNode, NodeStatus } from '@shared/types'

/** @main-process-only 函数类型无法通过 IPC 序列化，仅用于主进程行为调度 */
export interface NodeTypeBehavior {
  /** 节点创建时触发 */
  onCreate?: (node: GraphNode) => void | Promise<void>
  /** 节点删除时触发 */
  onDelete?: (nodeId: string) => void | Promise<void>
  /** 节点状态变更时触发 */
  onStatusChange?: (nodeId: string, from: NodeStatus, to: NodeStatus) => void | Promise<void>
}
