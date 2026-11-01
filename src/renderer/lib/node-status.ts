import type { NodeStatus } from '@shared/types'

/** 可达集合只剩当前状态时，该节点没有合法迁出。 */
export function isTerminalStatus(
  status: NodeStatus,
  reachableStatuses: readonly NodeStatus[],
): boolean {
  return reachableStatuses.every((reachable) => reachable === status)
}
