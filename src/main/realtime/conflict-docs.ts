/**
 * Y.Doc 工厂（最小可用版，D10d 临时使用）
 *
 * D10a 计划做 SQLite ⇄ Y.Doc 双向同步 + WebSocket 服务；D10c 计划做
 * snapshot 持久化。在它们落地之前，D10d 需要一个能挂 conflict resolver
 * 的最小 Y.Doc 容器。本文件提供：
 *   - getOrCreateRealtimeDoc(graphId) → 进程级缓存的 Y.Doc
 *   - getRealtimeDoc(graphId) → 已存在则返回，否则 undefined
 *   - closeRealtimeDoc(graphId) → 释放 doc 实例
 *
 * 与 D10a/D10c 的衔接：
 *   - D10a 落地后，`getOrCreateRealtimeDoc` 会被替换为「先加载 snapshot
 *     再 hydrate SQLite 行」。ConflictReporter 仍按 graphId 调它即可。
 *   - 当前实现：纯内存 Y.Doc，重启即丢；只在测试与 D10d 阶段使用。
 */

import * as Y from 'yjs'

const docRegistry = new Map<string, Y.Doc>()

/** 获取或创建 graphId 对应的 Y.Doc；同一 actor 内幂等。 */
export function getOrCreateRealtimeDoc(graphId: string): Y.Doc {
  let doc = docRegistry.get(graphId)
  if (!doc) {
    doc = new Y.Doc({ guid: graphId })
    docRegistry.set(graphId, doc)
  }
  return doc
}

/** 取已存在的 Y.Doc；不存在则返回 undefined（不创建） */
export function getRealtimeDoc(graphId: string): Y.Doc | undefined {
  return docRegistry.get(graphId)
}

/** 关闭并销毁 graphId 对应的 Y.Doc；未注册则 no-op */
export function closeRealtimeDoc(graphId: string): void {
  const doc = docRegistry.get(graphId)
  if (!doc) return
  doc.destroy()
  docRegistry.delete(graphId)
}

/** 关闭所有 Y.Doc（应用退出 hook 调用） */
export function closeAllRealtimeDocs(): void {
  for (const [graphId, doc] of docRegistry) {
    doc.destroy()
    docRegistry.delete(graphId)
  }
}

/** 测试专用：清空 registry */
export function __resetRealtimeDocRegistry(): void {
  closeAllRealtimeDocs()
}

/** 当前已注册的 doc 数量（仅供调试 / 监控） */
export function realtimeDocCount(): number {
  return docRegistry.size
}