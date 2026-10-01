/**
 * Ambient type augmentation: 补齐 yjs 的 ObservableV2 派生类（D.Doc、Y.Map、Y.Array 等）
 * 的事件 API（on / once / off / emit），因为基类来自 lib0（无 .d.ts）。
 *
 * 仅声明本项目实际用到的最小 API。运行时行为由 lib0 的 ObservableV2 保证。
 */

export {} // 把本文件标记为 module，declare module 才生效

declare module 'yjs' {
  // 事件回调类型（按事件名分发参数）
  // 注意：这里使用 any 是必要的，因为 yjs DocEvents 的联合签名复杂，
  // 类型增强只为通过编译期检查，不影响运行期行为。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type DocEventHandler = (...args: any[]) => void

  interface Doc {
    on(eventName: string, handler: DocEventHandler): void
    once(eventName: string, handler: DocEventHandler): void
    off(eventName: string, handler: DocEventHandler): void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(eventName: string, ...args: any[]): void
    destroy(): void
  }
}

// YMap 的 observe / unobserve 已经在 AbstractType 上声明（observe / observeDeep）。
// 这里不再额外增强，避免与 yjs 自带签名冲突。
// 应用代码直接调用 `nodesMap.observe(handler)` 即可。
