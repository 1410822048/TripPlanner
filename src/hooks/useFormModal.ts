// src/hooks/useFormModal.ts
// Hook for the "open create / open edit / close" pattern that every
// list-with-CRUD page implemented by hand: BookingsPage, ExpensePage,
// SchedulePage. Returns a stable `key` derived from the editTarget id
// so `<Modal key={key}>` triggers an unmount → remount on switch,
// which gives every open a fresh useState init from props (no
// setState-in-effect needed for prop sync).
import { useState } from 'react'

interface Identifiable { id: string }

/** The identity a form draft was composed under. Captured at open and
 *  compared against the live values at save/delete time — the current trip
 *  can be switched out from under an open modal (kicked / trip deleted →
 *  useCurrentTripSync reselects; demo → signed-in transition), and a draft
 *  composed for trip A must never be written into trip B, nor under a
 *  different account. */
export interface FormModalScope {
  tripId: string | undefined
  uid:    string | undefined
}

/** Inline banner copy for a blocked save/delete after the scope changed.
 *  The draft is kept — the user closes and reopens the form themselves
 *  (an automatic close would eat the draft). */
export const FORM_SCOPE_CHANGED_MESSAGE = '旅程或帳號已切換，請關閉表單後重新開啟'

export interface UseFormModalResult<T extends Identifiable> {
  isOpen:     boolean
  editTarget: T | null
  /** A stable key for `<Modal key={key}>`. 'new' for create; target id for edit. */
  key:        string
  /** Last save error to render as an inline banner above SaveButton.
   *  Cleared automatically on open / close — page handleSave catch
   *  blocks call setError to surface the failure inline instead of
   *  relying on the auto-dismissing toast. */
  saveError:  string | null
  /** True while the modal is open and the live `scope` no longer matches
   *  the one captured at open. Save/delete handlers must refuse (keep the
   *  draft, show FORM_SCOPE_CHANGED_MESSAGE) — the mutation hooks are
   *  bound to the LIVE trip id, so proceeding would write into it. Always
   *  false when the hook was created without a scope. */
  scopeChanged: boolean
  openAdd:    () => void
  openEdit:   (target: T) => void
  close:      () => void
  setError:   (msg: string) => void
  clearError: () => void
}

export function useFormModal<T extends Identifiable>(
  scope?: FormModalScope,
): UseFormModalResult<T> {
  const [isOpen, setIsOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<T | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [openScope, setOpenScope] = useState<FormModalScope | null>(null)

  // Compiler memoises these — no manual useCallback needed.
  const openAdd = () => {
    setEditTarget(null)
    setSaveError(null)
    setOpenScope(scope ?? null)
    setIsOpen(true)
  }
  const openEdit = (target: T) => {
    setEditTarget(target)
    setSaveError(null)
    setOpenScope(scope ?? null)
    setIsOpen(true)
  }
  const close = () => {
    setIsOpen(false)
    setEditTarget(null)
    setSaveError(null)
    setOpenScope(null)
  }

  // Fail-closed: a scope captured at open with NO live scope to compare
  // against is treated as changed — the call site that stopped providing
  // one must not silently regain write access.
  const scopeChanged =
    isOpen &&
    openScope !== null &&
    (scope === undefined ||
      openScope.tripId !== scope.tripId ||
      openScope.uid !== scope.uid)

  return {
    isOpen,
    editTarget,
    key: editTarget?.id ?? 'new',
    saveError,
    scopeChanged,
    openAdd,
    openEdit,
    close,
    setError:   setSaveError,
    clearError: () => setSaveError(null),
  }
}
