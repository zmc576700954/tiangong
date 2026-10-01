/**
 * D10b: Awareness 共享类型（主进程侧 re-export）
 *
 * 实际定义见 `src/shared/realtime.ts`。这里 re-export 是为了保持 main 端
 * import 路径不变。
 */

export type {
  RemoteAwarenessState,
  AwarenessMessage,
  AwarenessChangeListener,
  RealtimeConnectionInfo,
} from '../../shared/realtime'

export {
  AWARENESS_MSG_QUERY_AWARENESS,
  AWARENESS_MSG_UPDATE,
  AWARENESS_MSG_REMOVE,
} from '../../shared/realtime'

import type { UserIdentity } from '../../shared/types'
export type { UserIdentity }