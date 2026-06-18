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
import { MUTATION_ACTION } from '@/services/queryClient'
import { mockTimestampNow } from '@/mocks/utils'
import type { CreateExpenseInput, Expense } from '@/types'

const expenseKeys = {
  all: (tripId: string, uid?: string) => ['expenses', tripId, uid ?? ''] as const,
}

export const useExpenses = createRealtimeListHook<Expense>({
  queryKeyFactory: expenseKeys.all,
  initialFetch:    (tripId, uid) => getExpensesByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToExpenses(tripId, uid, onData, onError),
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
    // `deletedAt: null` matches the schema invariant enforced by the
    // create rule and keeps optimistic cache shape consistent with server.
    // `receiptPurgedAt: null` mirrors the same invariant for the
    // receipt-purge marker — listener-reconciled rows always carry it,
    // so the optimistic row should too.
    patch:      (prev, { input, createdBy }) => {
      // `mode` is a wire-only discriminator (see ExpensePaymentMode) — strip
      // it so the optimistic Expense row never carries a non-Expense field.
      const { mode: _mode, ...expenseFields } = input
      return [
        { id: tempId(), tripId, memberIds: [createdBy], deletedAt: null, receiptPurgedAt: null, ...auditCreateMock(createdBy), ...expenseFields },
        ...prev,
      ]
    },
    action:     MUTATION_ACTION.CREATE_EXPENSE,
  })
}

/** Stable mutationKey for `useMutationState`-driven 「保存中」 pill on
 *  the row being updated. Pages call `usePendingMutationIds` with this
 *  key + `'expenseId'` to derive the set of in-flight update ids. */
export const expenseUpdateMutationKey = ['expenses', 'update'] as const

export function useUpdateExpense(tripId: string) {
  return useTripListMutation<Expense, {
    expenseId:  string
    updates:    Partial<CreateExpenseInput>
    uid:        string
    attachment?: File | null
    existing?:  { path?: string; thumbPath?: string }
  }>({
    tripId,
    keyFactory:  expenseKeys.all,
    mutationKey: expenseUpdateMutationKey,
    mutate:      ({ expenseId, updates, uid, attachment, existing }) =>
      updateExpense(tripId, expenseId, updates, { uid, attachment, existingPaths: existing }),
    patch:       (prev, { expenseId, updates, uid }) => {
      // Same wire-only `mode` strip as the create patch above.
      const { mode: _mode, ...changes } = updates
      return prev.map(e => e.id === expenseId ? { ...e, ...changes, ...auditUpdateMock(uid) } : e)
    },
    action:      MUTATION_ACTION.UPDATE,
  })
}

export function useDeleteExpense(tripId: string) {
  return useTripListMutation<Expense, { expenseId: string }>({
    tripId,
    keyFactory: expenseKeys.all,
    mutate:     ({ expenseId }, { uid }) => deleteExpense(tripId, expenseId, uid),
    // Soft-delete: stamp the row with deletedAt so settlement replay
    // sees it during the optimistic window. ExpensePage's displayExpenses
    // filter hides it from the list as if gone; SettlementSummary still
    // has the full timeline. Listener reconciles to the real timestamp.
    patch:      (prev, { expenseId }) =>
      prev.map(e => e.id === expenseId ? { ...e, deletedAt: mockTimestampNow() } : e),
    action:     MUTATION_ACTION.DELETE,
  })
}
