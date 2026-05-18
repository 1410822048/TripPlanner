// src/features/expense/hooks/useExpenses.ts
// Realtime-backed via createRealtimeListHook — co-traveller's expense
// records appear immediately, which is the most "live" feature during
// a trip. Mutations stay optimistic for instant feedback; listener
// reconciles temp-id rows on server confirmation.
import {
  getExpensesByTrip,
  subscribeToExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} from '../services/expenseService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { tempId } from '@/utils/tempId'
import { auditCreateMock, auditUpdateMock } from '@/utils/audit'
import type { CreateExpenseInput, Expense } from '@/types'

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
  return useTripListMutation<Expense, { input: CreateExpenseInput; createdBy: string; attachment?: File | null }>({
    tripId,
    keyFactory: expenseKeys.all,
    mutate:     ({ input, createdBy, attachment }) => createExpense(tripId, input, createdBy, attachment),
    // Prepend so the new expense joins the top of the date-desc list,
    // matching where the real row will land once the listener reconciles
    // (server-sorted by date desc + createdAt desc; today's new row goes first).
    patch:      (prev, { input, createdBy }) => [
      { id: tempId(), tripId, memberIds: [createdBy], ...auditCreateMock(createdBy), ...input },
      ...prev,
    ],
    action:     '費用の追加',
  })
}

export function useUpdateExpense(tripId: string) {
  return useTripListMutation<Expense, {
    expenseId:  string
    updates:    Partial<CreateExpenseInput>
    uid:        string
    attachment?: File | null
    existing?:  { path?: string; thumbPath?: string }
  }>({
    tripId,
    keyFactory: expenseKeys.all,
    mutate:     ({ expenseId, updates, uid, attachment, existing }) =>
      updateExpense(tripId, expenseId, updates, { uid, attachment, existingPaths: existing }),
    patch:      (prev, { expenseId, updates, uid }) =>
      prev.map(e => e.id === expenseId ? { ...e, ...updates, ...auditUpdateMock(uid) } : e),
    action:     '更新',
  })
}

export function useDeleteExpense(tripId: string) {
  return useTripListMutation<Expense, {
    expenseId: string
    paths?:    { path?: string; thumbPath?: string }
  }>({
    tripId,
    keyFactory: expenseKeys.all,
    mutate:     ({ expenseId, paths }, { uid }) => deleteExpense(tripId, expenseId, uid, paths),
    patch:      (prev, { expenseId }) => prev.filter(e => e.id !== expenseId),
    action:     '削除',
  })
}
