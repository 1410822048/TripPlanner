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
import { AlertCircle } from 'lucide-react'
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
  /** Inline error banner above the SaveButton. Set by page handleSave
   *  catch blocks(via useFormModal.setError)so failures stay visible
   *  until the user re-attempts — beats the 7-second toast for
   *  modal-driven flows where the form state is already loaded. */
  saveError?: string | null
}

export default function FormModalShell({
  isOpen, isSaving, title, saveLabel, onClose, onSave, children, saveError,
}: Props) {
  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <div className="space-y-2">
          {saveError && (
            <div
              role="alert"
              className="flex items-start gap-2 px-3 py-2 rounded-input bg-danger-pale border border-danger-soft text-danger text-[12px] font-medium leading-[1.45]"
            >
              <AlertCircle size={14} strokeWidth={2.2} className="shrink-0 mt-px" />
              <span className="flex-1 min-w-0">{saveError}</span>
            </div>
          )}
          <SaveButton onClick={onSave} isSaving={isSaving} label={saveLabel} />
        </div>
      }
    >
      {children}
    </BottomSheet>
  )
}
