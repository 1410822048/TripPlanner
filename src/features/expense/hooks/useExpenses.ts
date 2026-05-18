// src/features/expense/hooks/useExpenses.ts
// Realtime-backed via createRealtimeListHook — co-traveller's expense
// records appear immediately, which is the most "live" feature during
// a trip (everyone records their share as they go). See useSchedules.ts
// for the optimistic-update pattern rationale.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getExpensesByTrip,
  subscribeToExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} from '../services/expenseService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useUid } from '@/hooks/useAuth'
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { CreateExpenseInput, Expense } from '@/types'
import type { MutationMeta } from '@/services/queryClient'

export const expenseKeys = {
  all: (tripId: string, uid?: string) => ['expenses', tripId, uid ?? ''] as const,
}

export const useExpenses = createRealtimeListHook<Expense>({
  queryKeyFactory: expenseKeys.all,
  initialFetch:    (tripId, uid) => getExpensesByTrip(tripId, uid!),
  subscribe:       (tripId, uid, onData, onError) => subscribeToExpenses(tripId, uid!, onData, onError),
  source:          'useExpenses',
  requiresUid:     true,
})

export function useCreateExpense(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = expenseKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ input, userId, attachment }: { input: CreateExpenseInput; userId: string; attachment?: File | null }) =>
      createExpense(tripId, input, userId, attachment),
    onMutate: ({ input, userId }) =>
      patchListCache<Expense>(qc, key, prev => [
        ...prev,
        { id: tempId(), tripId, memberIds: [userId], ...auditCreateMock(userId), ...input },
      ]),
    meta: { action: '費用の追加' } satisfies MutationMeta,
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Expense>(qc, key, ctx)
    },
  })
}

export function useUpdateExpense(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = expenseKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({
      expenseId, updates, uid, attachment, existing,
    }: {
      expenseId:  string
      updates:    Partial<CreateExpenseInput>
      uid:        string
      attachment?: File | null
      existing?:  { path?: string; thumbPath?: string }
    }) =>
      updateExpense(tripId, expenseId, updates, { uid, attachment, existingPaths: existing }),
    onMutate: ({ expenseId, updates, uid }) =>
      patchListCache<Expense>(qc, key, prev =>
        prev.map(e => e.id === expenseId ? { ...e, ...updates, ...auditUpdateMock(uid) } : e),
      ),
    meta: { action: '更新' } satisfies MutationMeta,
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Expense>(qc, key, ctx)
    },
  })
}

export function useDeleteExpense(tripId: string) {
  const qc = useQueryClient()
  const uid = useUid()
  const key = expenseKeys.all(tripId, uid)
  return useMutation({
    mutationFn: ({ expenseId, paths }: { expenseId: string; paths?: { path?: string; thumbPath?: string } }) =>
      deleteExpense(tripId, expenseId, uid!, paths),
    onMutate: ({ expenseId }) =>
      patchListCache<Expense>(qc, key, prev => prev.filter(e => e.id !== expenseId)),
    meta: { action: '削除' } satisfies MutationMeta,
    onError: (_err, _vars, ctx) => {
      rollbackListCache<Expense>(qc, key, ctx)
    },
  })
}
