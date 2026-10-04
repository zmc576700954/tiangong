/**
 * Toast 系统 — Zustand store + useToast hook + ToastContainer。
 *
 * 设计要点：
 * - 不引新依赖（react + zustand 已装）
 * - 自动消失：success/info 默认 3000ms，error 默认 5000ms
 * - 手动 dismiss：每条 toast 自带 close 按钮
 * - 定位：top-3 right-3 z-[100]，最高层级，不被画布盖住
 */

import { create } from 'zustand'

export type ToastKind = 'success' | 'info' | 'error'

export interface ToastItem {
  id: string
  kind: ToastKind
  message: string
  /** 自动消失的毫秒数；0 = 不自动消失 */
  durationMs: number
}

interface ToastState {
  toasts: ToastItem[]
  pushToast: (kind: ToastKind, message: string, durationMs?: number) => string
  dismissToast: (id: string) => void
  clearToasts: () => void
}

let counter = 0
const nextId = (): string => {
  counter += 1
  return `toast-${Date.now().toString(36)}-${counter}`
}

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  success: 3000,
  info: 3000,
  error: 5000,
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  pushToast: (kind, message, durationMs) => {
    const id = nextId()
    const finalDuration = durationMs ?? DEFAULT_DURATIONS[kind]
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, durationMs: finalDuration }] }))
    if (finalDuration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, finalDuration)
    }
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
}))

/**
 * useToast — 调用方直接拿 `success / info / error / dismiss` 四个方法。
 */
export function useToast() {
  const pushToast = useToastStore((s) => s.pushToast)
  const dismissToast = useToastStore((s) => s.dismissToast)
  return {
    success: (message: string, durationMs?: number) => pushToast('success', message, durationMs),
    info: (message: string, durationMs?: number) => pushToast('info', message, durationMs),
    error: (message: string, durationMs?: number) => pushToast('error', message, durationMs),
    dismiss: dismissToast,
  }
}