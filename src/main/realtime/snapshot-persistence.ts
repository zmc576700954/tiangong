/**
 * SnapshotPersistence — 防抖保存 Y.Doc 状态到 SQLite yjs_snapshots 表。
 *
 * 防抖策略：任意变更后启动 1s 定时器，期间如果再来变更则重置。
 * 文档或服务关闭时强制 flushSync 一次（避免最后一波变更丢失）。
 *
 * 与渲染端 y-indexeddb 的区别：这是主进程 → SQLite 路径（权威持久化），
 * 渲染端 IndexedDB 是离线缓存，二者互不冲突、各自 debounce。
 */

import { type SnapshotStore } from './snapshot-store'
import { type YjsDocument } from './yjs-doc'
import { createLogger } from '../shared/logger'

const logger = createLogger('SnapshotPersistence')

export interface SnapshotPersistenceOptions {
  /** 防抖毫秒数；默认 1000ms（D10c 设计门槛）。 */
  debounceMs?: number
  /** 每次成功保存后回调，可用于广播或调试 */
  onSaved?: (graphId: string, docState: Uint8Array) => void
  /** 失败回调 */
  onError?: (err: unknown, graphId: string) => void
}

/**
 * 给一张图绑定自动保存。observer 调到一个挂在 Y.Doc 上的 snapshot。
 * 返回 dispose 函数（含立即 flush）。
 */
export function attachSnapshotPersistence(
  graphId: string,
  doc: YjsDocument,
  store: SnapshotStore,
  options: SnapshotPersistenceOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false
  let disposed = false

  const flushNow = (): void => {
    if (!pending) return
    pending = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      const state = doc.encodeState()
      store.save(graphId, state)
      options.onSaved?.(graphId, state)
    } catch (err) {
      try {
        options.onError?.(err, graphId)
      } catch (handlerErr) {
        logger.warn('onError handler threw:', handlerErr)
      }
      logger.warn(`snapshot save failed for ${graphId}:`, err)
    }
  }

  const schedule = (): void => {
    pending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flushNow()
    }, debounceMs)
    // 不阻止进程退出
    if (typeof timer.unref === 'function') timer.unref()
  }

  const unsubscribe = doc.observe(() => {
    schedule()
  })

  // dispose 给整个生命周期，先 flush 一次确保最后状态落盘，再解订。
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    flushNow()
  }
}

/** 同步立即保存（不走防抖）。用于显式触发（如刚完成 schema 升级）。 */
export async function saveSnapshotImmediate(
  graphId: string,
  doc: YjsDocument,
  store: SnapshotStore,
): Promise<void> {
  const state = doc.encodeState()
  store.save(graphId, state)
}