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
import { tempId } from '@/utils/tempId'
import { patchListCache, rollbackListCache } from '@/utils/queryCache'
import type { CreateExpenseInput, Expense } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const expenseKeys = {
  all: (tripId: string) => ['expenses', tripId] as const,
}

export const useExpenses = createRealtimeListHook<Expense>({
  queryKeyFactory: expenseKeys.all,
  initialFetch:    getExpensesByTrip,
  subscribe:       subscribeToExpenses,
  source:          'useExpenses',
})

export function useCreateExpense(tripId: string) {
  const qc = useQueryClient()
  const key = expenseKeys.all(tripId)
  return useMutation({
    mutationFn: ({ input, userId, attachment }: { input: CreateExpenseInput; userId: string; attachment?: File | null }) =>
      createExpense(tripId, input, userId, attachment),
    onMutate: ({ input, userId }) =>
      patchListCache<Expense>(qc, key, prev => [
        ...prev,
        {
          id:        tempId(),
          tripId,
          createdBy: userId,
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
          ...input,
        },
      ]),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Expense>(qc, key, ctx)
      toast.mutationError(err, '費用の追加')
    },
  })
}

export function useUpdateExpense(tripId: string) {
  const qc = useQueryClient()
  const key = expenseKeys.all(tripId)
  return useMutation({
    mutationFn: ({
      expenseId, updates, attachment, existing,
    }: {
      expenseId: string
      updates:   Partial<CreateExpenseInput>
      attachment?: File | null
      existing?: { path?: string; thumbPath?: string }
    }) =>
      updateExpense(tripId, expenseId, updates, attachment, existing),
    onMutate: ({ expenseId, updates }) =>
      patchListCache<Expense>(qc, key, prev =>
        prev.map(e => e.id === expenseId ? { ...e, ...updates, updatedAt: MOCK_TIMESTAMP } : e),
      ),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Expense>(qc, key, ctx)
      toast.mutationError(err, '更新')
    },
  })
}

export function useDeleteExpense(tripId: string) {
  const qc = useQueryClient()
  const key = expenseKeys.all(tripId)
  return useMutation({
    mutationFn: ({ expenseId, paths }: { expenseId: string; paths?: { path?: string; thumbPath?: string } }) =>
      deleteExpense(tripId, expenseId, paths),
    onMutate: ({ expenseId }) =>
      patchListCache<Expense>(qc, key, prev => prev.filter(e => e.id !== expenseId)),
    onError: (err, _vars, ctx) => {
      rollbackListCache<Expense>(qc, key, ctx)
      toast.mutationError(err, '削除')
    },
  })
}
