/**
 * ToastContainer — 全局 toast 渲染容器，挂在 App 顶层。
 *
 * 固定在 top-3 right-3，最大 z-index；每条 toast 自带关闭按钮。
 * 颜色按 kind 区分：success=绿，info=蓝，error=红。
 */

import { useToastStore, type ToastItem } from '../../lib/toast'

const KIND_STYLES: Record<ToastItem['kind'], string> = {
  success: 'bg-green-50 border-green-300 text-green-900',
  info: 'bg-blue-50 border-blue-300 text-blue-900',
  error: 'bg-red-50 border-red-300 text-red-900',
}

const KIND_ICONS: Record<ToastItem['kind'], string> = {
  success: '✓',
  info: 'ℹ',
  error: '✕',
}

function ToastRow({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismissToast)
  return (
    <div
      role="status"
      aria-live={item.kind === 'error' ? 'assertive' : 'polite'}
      className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 shadow-md text-sm ${KIND_STYLES[item.kind]}`}
    >
      <span className="font-bold" aria-hidden>{KIND_ICONS[item.kind]}</span>
      <span className="flex-1 whitespace-pre-wrap break-words">{item.message}</span>
      <button
        type="button"
        onClick={() => dismiss(item.id)}
        className="ml-1 text-current opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed top-3 right-3 z-[100] flex w-80 max-w-[90vw] flex-col gap-2">
      {toasts.map((t) => (
        <ToastRow key={t.id} item={t} />
      ))}
    </div>
  )
}