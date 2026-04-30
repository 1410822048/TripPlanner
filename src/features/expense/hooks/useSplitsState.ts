// src/features/expense/hooks/useSplitsState.ts
// Split-mode + included-members + custom-amount state for the expense
// form. Three pieces of state move in lockstep (toggling include while
// in custom mode also writes to custom; switching mode seeds the next
// mode from the previous one), so a reducer keeps mutations honest.
//
// Kept feature-scoped — the API is too expense-specific to belong in a
// generic hook (`useFormReducer` covers the simple "set field" case).
import { useReducer } from 'react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'

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
  }
}

/**
 * Derive initial split state from an existing expense (edit) or default
 * to "equal split among all members" (create). The mode detection looks
 * at whether the persisted splits are within ±1 of each other on
 * non-zero entries — typical equal-split rounding error tolerance.
 */
function initFromExpense(editTarget: Expense | null, members: TripMember[]): SplitsState {
  if (!editTarget) {
    return {
      mode:     'equal',
      included: new Set(members.map(m => m.id)),
      custom:   {},
    }
  }
  const nonZero = editTarget.splits.filter(s => s.amount > 0)
  const first = nonZero[0]
  const allEqual =
    first !== undefined &&
    nonZero.every(s => Math.abs(s.amount - first.amount) <= 1)

  if (allEqual) {
    return {
      mode:     'equal',
      included: new Set(nonZero.map(s => s.memberId)),
      custom:   {},
    }
  }
  const custom: Record<string, string> = {}
  editTarget.splits.forEach(s => { custom[s.memberId] = String(s.amount) })
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
}

export function useSplitsState(
  editTarget: Expense | null,
  members:    TripMember[],
): UseSplitsStateResult {
  const [state, dispatch] = useReducer(reducer, undefined,
    () => initFromExpense(editTarget, members),
  )
  return {
    state,
    toggleIncluded: id          => dispatch({ kind: 'toggleIncluded', id }),
    switchMode:     (mode, seed) => dispatch({ kind: 'switchMode', mode, seed }),
    setCustom:      (id, value)  => dispatch({ kind: 'setCustom', id, value }),
  }
}
