// src/services/queryClient.ts
// QueryClient + global MutationCache error handler. Each mutation hook
// declares `meta: { action, silent? }`; this single handler captures to
// Sentry and toasts unless `silent` is set(modal-banner flows opt out).
import { QueryClient, MutationCache } from '@tanstack/react-query'
import { toast } from '@/shared/toast'
import { captureError } from '@/services/sentry'

/** Centralised Japanese verb phrases used as `MutationMeta.action`.
 *  Surfaces in the failure toast prefix and the Sentry tag, so a typo
 *  silently breaks Sentry aggregation while still looking fine in the
 *  toast. Keeping them in one constant map prevents drift and lets the
 *  IDE autocomplete the right phrase at the call site.
 *
 *  Add new entries when a new mutation hook needs a phrase that isn't
 *  one of the shared verbs. Keep entity-specific creates (`予約の追加`)
 *  separate from generic verbs (`追加`, `更新`, `削除`) — share within
 *  an entity family, not across. */
export const MUTATION_ACTION = {
  // ── Generic verbs (update / delete reused across all entities) ─
  UPDATE: '更新',
  DELETE: '刪除',

  // ── Entity-specific create labels ──────────────────────────────
  // All five list entities get their own create label so the failure
  // toast (`{label}に失敗`) reads naturally and the Sentry tag pinpoints
  // which entity broke. Don't fall back to a generic `ADD` — it
  // fragments aggregation and reads worse in the UI.
  CREATE_BOOKING:    '新增訂單',
  CREATE_EXPENSE:    '新增費用',
  CREATE_SCHEDULE:   '新增行程',
  CREATE_WISH:       '新增心願',
  CREATE_PLAN:       '新增準備項目',

  // ── Specialty mutations ────────────────────────────────────────
  TOGGLE_VOTE:       '投票',
  CHANGE_ROLE:       '變更權限',
  TRANSFER_OWNER:    '轉讓擁有者',
  RECORD_SETTLEMENT: '清算記録',
  CANCEL_SETTLEMENT: '取消清算',
  CREATE_INVITE:     '邀請連結作成',
  REVOKE_INVITE:     '撤銷邀請',
} as const

export type MutationActionLabel = typeof MUTATION_ACTION[keyof typeof MUTATION_ACTION]

export interface MutationMeta extends Record<string, unknown> {
  /** Verb phrase for toast / Sentry tag. Must come from `MUTATION_ACTION`
   *  — keeping the union closed prevents typo'd raw strings from silently
   *  fragmenting the Sentry aggregation. Add new labels there. */
  action?: MutationActionLabel
  /** Skip the global toast. Set when the caller surfaces the failure
   *  inline(modal banner / form-level error)so the user doesn't see
   *  two notifications for the same problem. */
  silent?: boolean
}

/** Shared option shape for mutation hooks that accept `silent`. Saves
 *  the inline `options?: { silent?: boolean }` repetition across the
 *  8+ modal-driven create / update hooks. */
export interface MutationOptions {
  silent?: boolean
}

// Module-augment so `mutation.meta` is typed app-wide and we don't need
// `as MutationMeta` casts inside the global handler / any future caller.
declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: MutationMeta
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:  1000 * 60 * 5,
      gcTime:     1000 * 60 * 30,
      retry:      2,
      refetchOnWindowFocus: false,
    },
  },
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      const meta = mutation.meta
      // WorkerAmbiguous = the write request reached the network but the
      // response was lost (timeout / network / 5xx); the mutation MAY
      // have committed. Realtime listeners reconcile the true state, so
      // a hard 「失敗」 toast false-alarms the common case — e.g. a
      // Firestore contention retry that actually landed but overran the
      // client timeout. Surface a softer "still confirming" line instead.
      const isAmbiguous = (err as { name?: string } | null)?.name === 'WorkerAmbiguous'
      // Always capture — silent only suppresses the user-facing toast,
      // not the debugging signal. Tag ambiguity so contention spikes are
      // greppable separately from definitive failures in Sentry.
      captureError(err as Error, {
        source:    'mutationCache',
        action:    meta?.action ?? 'unknown',
        ambiguous: isAmbiguous,
      })
      if (meta?.silent) return
      if (isAmbiguous) {
        toast.info('網路不穩定，正在確認是否已完成更新')
        return
      }
      toast.mutationError(err, meta?.action ?? '操作')
    },
  }),
})
