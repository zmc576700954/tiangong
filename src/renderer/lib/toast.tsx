/**
 * 全局 Toast 系统
 *
 * BizGraph 此前无统一 toast 方案，关键失败（如 writeback 采纳失败）只打 console。
 * 这里提供一个极简实现：zustand 状态 + `<ToastContainer />` 渲染。
 * 自动 dismiss（4s 默认），点击关闭，支持 success / error / info 三种 kind。
 *
 * 接入方式：
 *   1) `<App />` 顶层挂 `<ToastContainer />`
 *   2) 任何地方：`pushToast({ kind: 'error', title: '采纳失败', message: err.message })`
 *
 * 该文件同时导出组件和 store/便捷函数。fast-refresh 会要求文件只导出组件，
 * 但拆分 .ts/.tsx 会让测试和上层用 `from '../toast'` 解析到 .ts 而拿不到组件；
 * 故统一放在 .tsx 中，对 react-refresh/only-export-components 单条规则禁用。
 */

/* eslint-disable react-refresh/only-export-components */

import { create } from 'zustand'
import { useEffect } from 'react'
import { cn } from './utils'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'

export type ToastKind = 'success' | 'error' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  message?: string
  /** auto-dismiss 毫秒数；0 表示不自动消失 */
  durationMs?: number
  /** 不透明创建时间戳，用于计算剩余时间 */
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id' | 'createdAt'>) => string
  dismiss: (id: string) => void
  clear: () => void
}

const DEFAULT_DURATION = 4000

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fullToast: Toast = {
      id,
      createdAt: Date.now(),
      durationMs: toast.durationMs ?? DEFAULT_DURATION,
      kind: toast.kind,
      title: toast.title,
      message: toast.message,
    }
    set((s) => ({ toasts: [...s.toasts, fullToast] }))
    return id
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  clear: () => set({ toasts: [] }),
}))

/** 简化调用 API —— 直接调用 pushToast，无须 hook 包装 */
export function pushToast(toast: Omit<Toast, 'id' | 'createdAt'>): string {
  return useToastStore.getState().push(toast)
}

/** 便捷方法 */
export function toastSuccess(title: string, message?: string): string {
  return pushToast({ kind: 'success', title, message })
}
export function toastError(title: string, message?: string): string {
  return pushToast({ kind: 'error', title, message, durationMs: 6000 })
}
export function toastInfo(title: string, message?: string): string {
  return pushToast({ kind: 'info', title, message })
}

/**
 * 全局 Toast 容器。挂在 `<App />` 顶层即可（仅渲染一次，订阅一次）。
 * 使用 zustand 的 selector 隔离重渲染：每个 toast 卡片单独订阅自己的 dismiss。
 */
export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      data-testid="toast-container"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss)
  useEffect(() => {
    if (toast.durationMs && toast.durationMs > 0) {
      const t = setTimeout(() => dismiss(toast.id), toast.durationMs)
      return () => clearTimeout(t)
    }
    return undefined
  }, [toast.id, toast.durationMs, dismiss])
  const Icon = toast.kind === 'success' ? CheckCircle2 : toast.kind === 'error' ? AlertCircle : Info
  const colorClass =
    toast.kind === 'success'
      ? 'border-green-300 bg-green-50 text-green-900'
      : toast.kind === 'error'
        ? 'border-red-300 bg-red-50 text-red-900'
        : 'border-blue-300 bg-blue-50 text-blue-900'

  return (
    <div
      role="status"
      data-testid={`toast-${toast.kind}`}
      className={cn(
        'pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-md border shadow-md max-w-sm min-w-[240px]',
        colorClass,
      )}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight">{toast.title}</p>
        {toast.message && (
          <p className="text-xs mt-0.5 leading-snug opacity-90 break-words">{toast.message}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="关闭通知"
        title="关闭"
        className="shrink-0 p-0.5 rounded hover:bg-black/10 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}