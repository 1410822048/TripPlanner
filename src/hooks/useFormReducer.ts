// src/hooks/useFormReducer.ts
// Generic typed form-state reducer. Three modal forms in the app
// (BookingFormModal, WishFormModal, JournalFormModal — though the last
// one was rolled into Wish) each had ~10 useState calls or a copy-pasted
// reducer of identical shape: "set field by name". This consolidates
// that pattern into one hook so adding/removing fields is a one-line
// type change.
//
// Why useReducer over useState<object>: a reducer makes "set one field"
// the only mutation the component does, which keeps state changes
// visible from one place. With useState<object>, every callsite has to
// `setForm(prev => ({ ...prev, foo: x }))` and any forgotten spread is
// a silent state-clobber bug.
import { useReducer } from 'react'

type Action<T> = { kind: 'set'; field: keyof T; value: T[keyof T] }

function reducer<T>(state: T, action: Action<T>): T {
  switch (action.kind) {
    case 'set': return { ...state, [action.field]: action.value }
  }
}

export interface UseFormReducerResult<T> {
  state:    T
  setField: <K extends keyof T>(field: K, value: T[K]) => void
}

/**
 * Manage a flat record of form fields with one mutation API.
 *
 * @param init  Initial state. Pass a function to defer construction
 *              (matches `useReducer`'s lazy-init signature) — useful when
 *              the initial values come from an editTarget or a server
 *              shape that needs a small adapter.
 */
export function useFormReducer<T extends Record<string, unknown>>(
  init: T | (() => T),
): UseFormReducerResult<T> {
  const [state, dispatch] = useReducer(
    reducer<T>,
    undefined,
    () => typeof init === 'function' ? (init as () => T)() : init,
  )
  const setField = <K extends keyof T>(field: K, value: T[K]) => {
    dispatch({ kind: 'set', field, value: value as T[keyof T] })
  }
  return { state, setField }
}
