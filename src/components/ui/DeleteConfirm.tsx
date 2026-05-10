// src/components/ui/DeleteConfirm.tsx
// Two-step inline delete prompt used by every entity's edit form
// (BookingFormModal / ExpenseFormModal / PlanningFormModal /
// ScheduleFormModal / WishFormModal). Sits just above the sticky save
// button so destructive actions stay discoverable but never compete
// for the primary CTA position.
//
// Two-step pattern: tap the trigger button → it morphs into a "削除し
// ますか？" panel with explicit cancel + delete affordances. Avoids the
// modal-on-modal jarring of a confirm dialog while still requiring an
// intentional second tap.
//
// State (`confirmDelete`) is owned internally — the whole point of
// extracting this is so individual form modals don't each reinvent it.
// Form modals already mount fresh per edit target (parent passes
// `key={editTarget?.id ?? 'new'}` and conditionally renders), so this
// component's local state resets correctly between edits.
import { useState } from 'react'

interface Props {
  /** The user-visible noun for what's being deleted. Composed into
   *  the prompt copy via `この{noun}を削除しますか？` and trigger button
   *  via `この{noun}を削除`. Pass nouns in Japanese (existing convention
   *  in this codebase) — e.g. "予約", "行程", "ウィッシュ". */
  noun:     string
  /** Fired after the user taps the second-step 削除 button. Caller
   *  performs the actual mutation + closes the modal. */
  onDelete: () => void
}

export default function DeleteConfirm({ noun, onDelete }: Props) {
  const [confirming, setConfirming] = useState(false)

  if (confirming) {
    return (
      <div className="flex gap-2 p-3 rounded-xl bg-danger-pale border border-danger-soft">
        <span className="flex-1 text-[12px] text-danger self-center leading-[1.5]">
          この{noun}を削除しますか？
        </span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="px-3 py-1.5 rounded-lg border border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer whitespace-nowrap hover:bg-app transition-colors"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="px-3 py-1.5 rounded-lg border border-danger-soft bg-transparent text-danger text-[12px] font-medium cursor-pointer whitespace-nowrap hover:bg-danger-pale transition-colors"
        >
          削除
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="w-full p-[11px] rounded-xl border border-danger-soft bg-transparent text-danger text-[13px] font-medium cursor-pointer tracking-[0.04em] hover:bg-danger-pale transition-colors"
    >
      この{noun}を削除
    </button>
  )
}
