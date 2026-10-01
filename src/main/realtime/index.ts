/**
 * Realtime module barrel exports (D10d).
 *
 * 公开 API 收敛到这里，避免散落导入导致循环依赖。
 */

export * from './lamport'
export * from './conflict-rules'
export {
  getOrCreateRealtimeDoc,
  getRealtimeDoc,
  closeRealtimeDoc,
  closeAllRealtimeDocs,
  realtimeDocCount,
  __resetRealtimeDocRegistry,
} from './yjs-doc'