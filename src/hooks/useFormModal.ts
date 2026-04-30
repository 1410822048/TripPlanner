// src/hooks/useFormModal.ts
// Hook for the "open create / open edit / close" pattern that every
// list-with-CRUD page implemented by hand: BookingsPage, ExpensePage,
// SchedulePage. Returns a stable `key` derived from the editTarget id
// so `<Modal key={key}>` triggers an unmount → remount on switch,
// which gives every open a fresh useState init from props (no
// setState-in-effect needed for prop sync).
import { useCallback, useState } from 'react'

interface Identifiable { id: string }

export interface UseFormModalResult<T extends Identifiable> {
  isOpen:     boolean
  editTarget: T | null
  /** A stable key for `<Modal key={key}>`. 'new' for create; target id for edit. */
  key:        string
  openAdd:    () => void
  openEdit:   (target: T) => void
  close:      () => void
}

export function useFormModal<T extends Identifiable>(): UseFormModalResult<T> {
  const [isOpen, setIsOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<T | null>(null)

  const openAdd = useCallback(() => {
    setEditTarget(null)
    setIsOpen(true)
  }, [])
  const openEdit = useCallback((target: T) => {
    setEditTarget(target)
    setIsOpen(true)
  }, [])
  const close = useCallback(() => {
    setIsOpen(false)
    setEditTarget(null)
  }, [])

  return {
    isOpen,
    editTarget,
    key: editTarget?.id ?? 'new',
    openAdd,
    openEdit,
    close,
  }
}
