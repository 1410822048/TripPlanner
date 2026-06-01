// src/features/expense/hooks/useSplitsState.ts
// Split-mode + included-members + custom-amount state for the expense
// form. Three pieces of state move in lockstep (toggling include while
// in custom mode also writes to custom; switching mode seeds the next
// mode from the previous one), so a reducer keeps mutations honest.
//
// Kept feature-scoped — the API is too expense-specific to belong in a
// generic hook (`useFormReducer` covers the simple "set field" case).
import { useReducer } from 'react'
import type { Expense, ExpenseSplit } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { formatMinorForInput } from '@/utils/money'

export type SplitMode = 'equal' | 'custom'

export interface SplitsState {
  mode:     SplitMode
  /** Member ids included in the equal-split. Ignored in custom mode. */
  included: Set<string>
  /** Per-member input strings. Empty string ≡ excluded. */
  custom:   Record<string, string>
}

type Action =
  | { kind: 'toggleIncluded'; id: string }
  | { kind: 'switchMode'; mode: SplitMode; seed: Record<string, string> }
  | { kind: 'setCustom'; id: string; value: string }
  | { kind: 'resetCustom'; next: Record<string, string> }

function reducer(state: SplitsState, action: Action): SplitsState {
  switch (action.kind) {
    case 'toggleIncluded': {
      const next = new Set(state.included)
      if (next.has(action.id)) next.delete(action.id); else next.add(action.id)
      return { ...state, included: next }
    }
    case 'switchMode': {
      if (action.mode === state.mode) return state
      // When entering custom mode, pre-fill from the seed (the equal-mode
      // results) so the user starts with a sensible distribution they
      // can tweak rather than an empty grid.
      return {
        ...state,
        mode:   action.mode,
        custom: action.mode === 'custom' ? action.seed : state.custom,
      }
    }
    case 'setCustom':
      return { ...state, custom: { ...state.custom, [action.id]: action.value } }
    case 'resetCustom':
      // Bulk-replace the custom map. Used by ExpenseFormModal.setSourceCurrency
      // to renormalize user-typed split text after a currency switch — same
      // hazard as items/adjustments (text is verbatim, amountMinor is
      // derived under the CURRENT currency at read time). Reducer stays
      // currency-agnostic; caller owns the normalize.
      return { ...state, custom: action.next }
  }
}

export interface SplitSeed {
  currency: string
  splits:   ExpenseSplit[]
}

/**
 * Derive initial split state from an existing expense (edit) or default
 * to "equal split among all members" (create). The mode detection looks
 * at whether the persisted splits are within ±1 of each other on
 * non-zero entries — typical equal-split rounding error tolerance.
 *
 * Foreign manual-total expenses persist two split domains: canonical
 * trip-currency `splits`, and hidden source-currency `sourceSplits`.
 * Editing must seed from the same currency the input controls parse.
 */
function initFromExpense(
  editTarget: Expense | null,
  members:    TripMember[],
  seed?:      SplitSeed,
): SplitsState {
  if (!editTarget) {
    return {
      mode:     'equal',
      included: new Set(members.map(m => m.id)),
      custom:   {},
    }
  }
  const splitCurrency = seed?.currency ?? editTarget.currency
  const splitRows     = seed?.splits   ?? editTarget.splits
  const nonZero = splitRows.filter(s => s.amountMinor > 0)
  const first = nonZero[0]
  const allEqual =
    first !== undefined &&
    nonZero.every(s => Math.abs(s.amountMinor - first.amountMinor) <= 1)

  if (allEqual) {
    return {
      mode:     'equal',
      included: new Set(nonZero.map(s => s.memberId)),
      custom:   {},
    }
  }
  const custom: Record<string, string> = {}
  splitRows.forEach(s => {
    custom[s.memberId] = formatMinorForInput(s.amountMinor, splitCurrency)
  })
  return {
    mode:     'custom',
    included: new Set(members.map(m => m.id)),
    custom,
  }
}

export interface UseSplitsStateResult {
  state:          SplitsState
  toggleIncluded: (id: string) => void
  switchMode:     (mode: SplitMode, seed: Record<string, string>) => void
  setCustom:      (id: string, value: string) => void
  resetCustom:    (next: Record<string, string>) => void
}

export function useSplitsState(
  editTarget: Expense | null,
  members:    TripMember[],
  seed?:      SplitSeed,
): UseSplitsStateResult {
  const [state, dispatch] = useReducer(reducer, undefined,
    () => initFromExpense(editTarget, members, seed),
  )
  return {
    state,
    toggleIncluded: id          => dispatch({ kind: 'toggleIncluded', id }),
    switchMode:     (mode, seed) => dispatch({ kind: 'switchMode', mode, seed }),
    setCustom:      (id, value)  => dispatch({ kind: 'setCustom', id, value }),
    resetCustom:    next         => dispatch({ kind: 'resetCustom', next }),
  }
}
