// src/shared/toast.ts
// Lightweight toast primitive built on Zustand. The module-level `toast`
// object can be called from anywhere (mutation handlers, services) — no
// provider / hook plumbing. The <Toaster /> component subscribes via hook.
import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'

/** Optional action button rendered inside the toast. Clicking it fires
 *  onClick and dismisses the toast — typically used for "やり直す" retry
 *  on mutation errors, but generic enough for any one-shot CTA.
 *
 *  Why a single action(not array): mobile toasts have ~12px of real
 *  estate for actions; cramming two buttons turns into a misclick trap.
 *  If you need more options, that's an inline dialog, not a toast. */
export interface ToastAction {
  label:   string
  onClick: () => void
}

export interface ToastItem {
  id:       string
  kind:     ToastKind
  message:  string
  action?:  ToastAction
  /** Internal: the setTimeout handle for auto-dismiss. Stored so manual
   *  dismiss can cancel the pending timer — otherwise the timer fires
   *  later and does a no-op filter, plus keeps the closure alive. */
  timerId?: number
}

export interface ToastOptions {
  /** Override the auto-dismiss timer. */
  ttlMs?: number
  /** Action button rendered inline. */
  action?: ToastAction
}

interface ToastState {
  items: ToastItem[]
  push:    (kind: ToastKind, message: string, options?: ToastOptions) => void
  dismiss: (id: string) => void
}

// Defaults are tiered by kind:
//   - success / info → 4s(typical glanceable confirmation)
//   - error          → 7s(longer so users have time to read + act)
//   - any with action → 12s(give thumb time to reach the retry button)
const DEFAULT_TTL_BY_KIND: Record<ToastKind, number> = {
  success: 4000,
  info:    4000,
  error:   7000,
}
const TTL_WITH_ACTION = 12_000

function defaultTtl(kind: ToastKind, hasAction: boolean): number {
  return hasAction ? TTL_WITH_ACTION : DEFAULT_TTL_BY_KIND[kind]
}

const RETRY_LABEL = 'やり直す'

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (kind, message, options) => {
    const id = `t_${crypto.randomUUID()}`
    const ttlMs = options?.ttlMs ?? defaultTtl(kind, !!options?.action)
    const timerId = window.setTimeout(() => get().dismiss(id), ttlMs)
    set(s => ({
      items: [...s.items, { id, kind, message, action: options?.action, timerId }],
    }))
  },
  dismiss: id => set(s => {
    const target = s.items.find(t => t.id === id)
    if (target?.timerId !== undefined) window.clearTimeout(target.timerId)
    return { items: s.items.filter(t => t.id !== id) }
  }),
}))

export const toast = {
  success: (message: string, options?: ToastOptions) =>
    useToastStore.getState().push('success', message, options),
  error:   (message: string, options?: ToastOptions) =>
    useToastStore.getState().push('error',   message, options),
  info:    (message: string, options?: ToastOptions) =>
    useToastStore.getState().push('info',    message, options),
  /**
   * Convenience wrapper for the mutation-onError boilerplate copy-pasted
   * across 21+ hook callsites:
   *
   *   toast.error(err instanceof Error ? `行程の追加に失敗：${err.message}` : '行程の追加に失敗しました')
   *
   * Becomes:
   *
   *   toast.mutationError(err, '行程の追加', onRetry)
   *
   * `action` is the verb phrase for the operation (e.g. '行程の追加',
   * '更新', '削除'); the helper appends 「に失敗：{cause}」 / 「に失敗
   * しました」 automatically.
   *
   * `onRetry`(optional): adds a 「やり直す」 action button. Mutation
   * hooks pass `() => retryRef.current?.(vars)` to retry with the same
   * arguments — see useCreateWish / useUpdateExpense for the pattern.
   */
  mutationError: (err: unknown, action: string, onRetry?: () => void) =>
    useToastStore.getState().push(
      'error',
      err instanceof Error ? `${action}に失敗：${err.message}` : `${action}に失敗しました`,
      onRetry ? { action: { label: RETRY_LABEL, onClick: onRetry } } : undefined,
    ),
}
