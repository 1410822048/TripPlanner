// src/features/expense/hooks/useExpenses.ts
// Realtime-backed via createRealtimeListHook — a co-traveller's expense
// records appear immediately, the most "live" feature during a trip.
// Optimistic state is a read-time overlay (see hooks/listOverlay.ts), so
// the cache stays server-shaped.
//
// Every write here is Worker-authoritative, which means every one of them
// can come back ambiguous — the request may or may not have committed.
import {
  expenseUpdateApplied,
  getExpensesByTrip,
  getExpensesByTripFromServer,
  subscribeToExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} from '../services/expenseService'
import { createRealtimeListHook } from '@/hooks/createRealtimeListHook'
import { createListOverlay } from '@/hooks/listOverlay'
import { useTripListMutation } from '@/hooks/useTripListMutation'
import { auditCreateMock } from '@/utils/audit'
import { MUTATION_ACTION } from '@/services/queryClient'
import { mockTimestampNow } from '@/mocks/utils'
import type { CreateExpenseInput, Expense } from '@/types'

export const expenseKeys = {
  all: (tripId: string, uid?: string) => ['expenses', tripId, uid ?? ''] as const,
}

export const expenseOverlay = createListOverlay<Expense>({
  // The list is date-desc, so a new expense joins at the top — where the
  // server row lands too.
  insert: 'head',
  source: 'expenses',
})

export const useExpenses = createRealtimeListHook<Expense>({
  queryKeyFactory: expenseKeys.all,
  initialFetch:    (tripId, uid) => getExpensesByTrip(tripId, uid),
  subscribe:       (tripId, uid, onData, onError) => subscribeToExpenses(tripId, uid, onData, onError),
  source:          'useExpenses',
  requiresUid:     true,
  overlay:         expenseOverlay,
})

const serverRead = (tripId: string, uid: string | undefined) =>
  () => getExpensesByTripFromServer(tripId, uid ?? '')

export function useCreateExpense(tripId: string) {
  return useTripListMutation<Expense, {
    expenseId:   string
    input:       CreateExpenseInput
    createdBy:   string
    attachment?: File | null
  }>({
    tripId,
    keyFactory: expenseKeys.all,
    mutate:     ({ expenseId, input, createdBy, attachment }) =>
      createExpense(tripId, input, createdBy, attachment, expenseId),
    overlay: {
      controller: expenseOverlay,
      op: ({ expenseId, input, createdBy }, { uid }) => {
        // `mode` is a wire-only discriminator (see ExpensePaymentMode) —
        // strip it so the optimistic row never carries a non-Expense field.
        const { mode: _mode, ...expenseFields } = input
        return {
          kind: 'create',
          // `deletedAt` / `receiptPurgedAt` null match the schema invariant
          // the create rule enforces, so the optimistic shape matches the
          // server's.
          row: {
            id: expenseId, tripId, memberIds: [createdBy],
            deletedAt: null, receiptPurgedAt: null,
            ...auditCreateMock(createdBy), ...expenseFields,
          } as Expense,
          confirms: base => base.some(e => e.id === expenseId),
          authoritativeFetch: serverRead(tripId, uid),
        }
      },
    },
    action:     MUTATION_ACTION.CREATE_EXPENSE,
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
    keyFactory:  expenseKeys.all,
    mutate:      ({ expenseId, updates, uid, attachment, existing }) =>
      updateExpense(tripId, expenseId, updates, { uid, attachment, existingPaths: existing }),
    overlay: {
      controller: expenseOverlay,
      op: ({ expenseId, updates }, { uid }) => {
        const { mode: _mode, ...changes } = updates
        return {
          kind: 'patch',
          id:   expenseId,
          // Applies the client's preview, including the trip-currency
          // projection of a foreign-currency edit. `confirms` deliberately
          // does not check that projection — the server derives it from the
          // FX snapshot, so its arrival replaces our preview with the
          // authoritative figure rather than reverting anything.
          apply: row => ({ ...row, ...changes }),
          confirms: base => {
            const stored = base.find(e => e.id === expenseId)
            return !!stored && expenseUpdateApplied(stored, updates)
          },
          authoritativeFetch: serverRead(tripId, uid),
        }
      },
    },
    action:      MUTATION_ACTION.UPDATE,
  })
}

export function useDeleteExpense(tripId: string) {
  return useTripListMutation<Expense, { expenseId: string }>({
    tripId,
    keyFactory: expenseKeys.all,
    mutate:     ({ expenseId }, { uid }) => deleteExpense(tripId, expenseId, uid),
    overlay: {
      controller: expenseOverlay,
      // A patch, not a remove: this is a soft delete. The row stays in the
      // list carrying `deletedAt`, because SettlementSummary replays the
      // full timeline to classify orphans — ExpensePage's own filter is
      // what hides it from the visible list.
      op: ({ expenseId }, { uid }) => ({
        kind: 'patch',
        id:   expenseId,
        // A real clock, not the epoch: chronological replay orders the
        // delete against expense creations, and MOCK_TIMESTAMP would sort
        // it before all of them.
        apply: row => ({ ...row, deletedAt: mockTimestampNow() }),
        confirms: base => {
          const stored = base.find(e => e.id === expenseId)
          return !!stored && stored.deletedAt != null
        },
        authoritativeFetch: serverRead(tripId, uid),
      }),
    },
    action:     MUTATION_ACTION.DELETE,
  })
}
