/**
 * D10b: 远端选中聚合 helper
 *
 * 与 RemoteCursors.tsx 拆开，避免 react-refresh 「只导出组件」规则
 * 的 warning（hMR 友好）。
 */

import {
  AWARENESS_COLOR_PALETTE,
  resolveAwarenessColor,
  type RemoteAwarenessState,
} from '@shared/realtime'
import type { UserIdentity } from '@shared/types'

export interface RemoteSelectionEntry {
  userId: string
  userName: string
  colorIndex: number
  color: string
}

/** 把 remote awareness 状态按 nodeId 切分（多个 user 选同一个节点 → 多个 entry） */
export function computeRemoteSelectionByNode(
  remoteStates: RemoteAwarenessState[],
  localUserId: string,
): Map<string, RemoteSelectionEntry[]> {
  const map = new Map<string, RemoteSelectionEntry[]>()
  for (const state of remoteStates) {
    if (state.user.userId === localUserId) continue
    const entry: RemoteSelectionEntry = {
      userId: state.user.userId,
      userName: state.user.userName,
      colorIndex: state.user.colorIndex,
      color: AWARENESS_COLOR_PALETTE[state.user.colorIndex] ?? AWARENESS_COLOR_PALETTE[0]!,
    }
    for (const nodeId of state.selectedNodeIds) {
      const list = map.get(nodeId)
      if (list) {
        list.push(entry)
      } else {
        map.set(nodeId, [entry])
      }
    }
  }
  return map
}

/** UserIdentity → color 工具（导出供 BizNode / 其他组件用） */
export function colorForUser(identity: Pick<UserIdentity, 'colorIndex'>): string {
  return resolveAwarenessColor(identity.colorIndex)
}