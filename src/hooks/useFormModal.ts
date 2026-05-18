// src/hooks/useFormModal.ts
// Hook for the "open create / open edit / close" pattern that every
// list-with-CRUD page implemented by hand: BookingsPage, ExpensePage,
// SchedulePage. Returns a stable `key` derived from the editTarget id
// so `<Modal key={key}>` triggers an unmount → remount on switch,
// which gives every open a fresh useState init from props (no
// setState-in-effect needed for prop sync).
import { useState } from 'react'

interface Identifiable { id: string }

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
  openAdd:    () => void
  openEdit:   (target: T) => void
  close:      () => void
  setError:   (msg: string) => void
  clearError: () => void
}

export function useFormModal<T extends Identifiable>(): UseFormModalResult<T> {
  const [isOpen, setIsOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<T | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Compiler memoises these — no manual useCallback needed.
  const openAdd = () => {
    setEditTarget(null)
    setSaveError(null)
    setIsOpen(true)
  }
  const openEdit = (target: T) => {
    setEditTarget(target)
    setSaveError(null)
    setIsOpen(true)
  }
  const close = () => {
    setIsOpen(false)
    setEditTarget(null)
    setSaveError(null)
  }

  return {
    isOpen,
    editTarget,
    key: editTarget?.id ?? 'new',
    saveError,
    openAdd,
    openEdit,
    close,
    setError:   setSaveError,
    clearError: () => setSaveError(null),
  }
}
