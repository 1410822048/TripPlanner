// src/features/expense/hooks/useExpenses.ts
// See useSchedules.ts for the optimistic-update pattern rationale.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getExpensesByTrip,
  createExpense,
  updateExpense,
  deleteExpense,
} from '../services/expenseService'
import type { CreateExpenseInput, Expense } from '@/types'
import { MOCK_TIMESTAMP } from '@/mocks/utils'
import { toast } from '@/shared/toast'

export const expenseKeys = {
  all: (tripId: string) => ['expenses', tripId] as const,
}

function tempId() { return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }

function patchCache(
  qc: ReturnType<typeof useQueryClient>,
  tripId: string,
  fn: (prev: Expense[]) => Expense[],
): { prev: Expense[] | undefined } {
  const key  = expenseKeys.all(tripId)
  const prev = qc.getQueryData<Expense[]>(key)
  qc.setQueryData<Expense[]>(key, fn(prev ?? []))
  return { prev }
}

export function useExpenses(tripId: string | undefined) {
  return useQuery({
    queryKey: expenseKeys.all(tripId ?? ''),
    queryFn:  () => getExpensesByTrip(tripId!),
    enabled:  !!tripId,
  })
}

export function useCreateExpense(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ input, userId }: { input: CreateExpenseInput; userId: string }) =>
      createExpense(tripId, input, userId),
    onMutate: ({ input, userId }) =>
      patchCache(qc, tripId, prev => {
        const optimistic: Expense = {
          id:        tempId(),
          tripId,
          createdBy: userId,
          createdAt: MOCK_TIMESTAMP,
          updatedAt: MOCK_TIMESTAMP,
          ...input,
        }
        return [...prev, optimistic]
      }),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(expenseKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `費用の追加に失敗：${err.message}` : '費用の追加に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: expenseKeys.all(tripId) }),
  })
}

export function useUpdateExpense(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ expenseId, updates }: { expenseId: string; updates: Partial<CreateExpenseInput> }) =>
      updateExpense(tripId, expenseId, updates),
    onMutate: ({ expenseId, updates }) =>
      patchCache(qc, tripId, prev =>
        prev.map(e => e.id === expenseId ? { ...e, ...updates, updatedAt: MOCK_TIMESTAMP } : e),
      ),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(expenseKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `更新に失敗：${err.message}` : '更新に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: expenseKeys.all(tripId) }),
  })
}

export function useDeleteExpense(tripId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (expenseId: string) => deleteExpense(tripId, expenseId),
    onMutate: expenseId =>
      patchCache(qc, tripId, prev => prev.filter(e => e.id !== expenseId)),
    onError: (err, _vars, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(expenseKeys.all(tripId), ctx.prev)
      toast.error(err instanceof Error ? `削除に失敗：${err.message}` : '削除に失敗しました')
    },
    onSettled: () => qc.invalidateQueries({ queryKey: expenseKeys.all(tripId) }),
  })
}
