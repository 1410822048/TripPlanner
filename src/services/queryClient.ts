// src/services/queryClient.ts
// QueryClient + global MutationCache error handler. Each mutation hook
// declares `meta: { action, silent? }`; this single handler captures to
// Sentry and toasts unless `silent` is set(modal-banner flows opt out).
import { QueryClient, MutationCache } from '@tanstack/react-query'
import { toast } from '@/shared/toast'
import { captureError } from '@/services/sentry'

export interface MutationMeta extends Record<string, unknown> {
  /** Verb phrase for toast / Sentry tag: '追加' / '更新' / '削除' / etc. */
  action?: string
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
      // Always capture — silent only suppresses the user-facing toast,
      // not the debugging signal.
      captureError(err as Error, {
        source: 'mutationCache',
        action: meta?.action ?? 'unknown',
      })
      if (meta?.silent) return
      toast.mutationError(err, meta?.action ?? '操作')
    },
  }),
})
