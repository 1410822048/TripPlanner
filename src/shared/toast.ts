// src/shared/toast.ts
// Lightweight toast primitive built on Zustand. The module-level `toast`
// object can be called from anywhere (mutation handlers, services) — no
// provider / hook plumbing. The <Toaster /> component subscribes via hook.
import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id:   string
  kind: ToastKind
  message: string
}

interface ToastState {
  items: ToastItem[]
  push:    (kind: ToastKind, message: string, ttlMs?: number) => void
  dismiss: (id: string) => void
}

const DEFAULT_TTL = 4000

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, message, ttlMs = DEFAULT_TTL) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    set(s => ({ items: [...s.items, { id, kind, message }] }))
    window.setTimeout(() => get().dismiss(id), ttlMs)
  },
  dismiss: id => set(s => ({ items: s.items.filter(t => t.id !== id) })),
}))

export const toast = {
  success: (message: string, ttlMs?: number) => useToastStore.getState().push('success', message, ttlMs),
  error:   (message: string, ttlMs?: number) => useToastStore.getState().push('error',   message, ttlMs),
  info:    (message: string, ttlMs?: number) => useToastStore.getState().push('info',    message, ttlMs),
}
