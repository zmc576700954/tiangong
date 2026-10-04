/**
 * Vitest global setup
 *
 * Mocks browser APIs that jsdom 不实现、但 @xyflow/react 等库需要。
 *
 * - ResizeObserver：@xyflow/react 在 mount 时调用，否则 ReferenceError。
 * - matchMedia：jsdom 缺失；xyflow / lucide-react 触发条件渲染时会用到。
 *
 * 用 .js 而非 .ts 是为了规避顶层 ESLint parser 配置；语义不变。
 */

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// 重复 setup（如 vitest --watch）时 ResizeObserver 已存在 —— 不重复挂。
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverMock
}

// jsdom 缺失 matchMedia；只在缺时挂 stub
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
}
