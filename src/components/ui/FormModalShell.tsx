// src/components/ui/FormModalShell.tsx
// Thin wrapper: BottomSheet + footer SaveButton. Every form modal in the
// app (Booking / Expense / Schedule / Edit Trip) repeats the same 6-line
// pattern at the JSX root; this just reads slightly cleaner and gives us
// one place to swap modals or restyle the save button later.
//
// Body content (the actual form fields) comes through children — the
// shell stays unopinionated about how individual forms manage their state
// or validation. That keeps the abstraction shallow on purpose: the
// expense splits / booking attachments / schedule location pickers are
// too divergent to fit a single config-driven generator.
import type { ReactNode } from 'react'
import BottomSheet from './BottomSheet'
import SaveButton from './SaveButton'

interface Props {
  isOpen:    boolean
  isSaving:  boolean
  title:     string
  saveLabel: string
  onClose:   () => void
  onSave:    () => void
  children:  ReactNode
}

export default function FormModalShell({
  isOpen, isSaving, title, saveLabel, onClose, onSave, children,
}: Props) {
  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={<SaveButton onClick={onSave} isSaving={isSaving} label={saveLabel} />}
    >
      {children}
    </BottomSheet>
  )
}
