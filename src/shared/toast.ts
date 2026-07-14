// src/shared/toast.ts
// Lightweight toast primitive built on Zustand. The module-level `toast`
// object can be called from anywhere (mutation handlers, services) — no
// provider / hook plumbing. The <Toaster /> component subscribes via hook.
import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id:       string
  kind:     ToastKind
  message:  string
  /** Internal: the setTimeout handle for auto-dismiss. Stored so manual
   *  dismiss can cancel the pending timer — otherwise the timer fires
   *  later and does a no-op filter, plus keeps the closure alive. */
  timerId?: number
}

interface ToastState {
  items: ToastItem[]
  push:    (kind: ToastKind, message: string) => void
  dismiss: (id: string) => void
}

// Defaults are tiered by kind:
//   - success / info → 4s(typical glanceable confirmation)
//   - error          → 7s(longer so users have time to read)
const DEFAULT_TTL_BY_KIND: Record<ToastKind, number> = {
  success: 4000,
  info:    4000,
  error:   7000,
}

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, message) => {
    const id = `t_${crypto.randomUUID()}`
    const timerId = window.setTimeout(() => get().dismiss(id), DEFAULT_TTL_BY_KIND[kind])
    set(s => ({
      items: [...s.items, { id, kind, message, timerId }],
    }))
  },
  dismiss: id => set(s => {
    const target = s.items.find(t => t.id === id)
    if (target?.timerId !== undefined) window.clearTimeout(target.timerId)
    return { items: s.items.filter(t => t.id !== id) }
  }),
}))

export const toast = {
  success: (message: string) =>
    useToastStore.getState().push('success', message),
  error:   (message: string) =>
    useToastStore.getState().push('error',   message),
  info:    (message: string) =>
    useToastStore.getState().push('info',    message),
  /**
   * Convenience wrapper for global mutation errors. `action` is the verb
   * phrase for the operation (e.g. '行程の追加', '保存', '削除').
   */
  mutationError: (err: unknown, action: string) =>
    useToastStore.getState().push(
      'error',
      err instanceof Error ? `${action}失敗：${err.message}` : `${action}失敗`,
    ),
}
