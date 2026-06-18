// src/components/ui/ConfirmSheet.tsx
// Reusable confirm dialog rendered as a BottomSheet. Replaces the native
// `window.confirm` which (a) can't be styled, (b) looks out of place in a
// PWA, and (c) forces the user gesture to go through the browser chrome.
// Use for any destructive action (logout, remove member, delete invite)
// so confirmation UX is identical across the app.
import type { ReactNode } from 'react'
import BottomSheet from '@/components/ui/BottomSheet'

type ConfirmSheetTone = 'danger' | 'neutral'
type ConfirmSheetLayout = 'row' | 'column'

interface Props {
  isOpen:          boolean
  title:           string
  description?:    ReactNode
  icon?:           ReactNode
  confirmLabel:    string
  cancelLabel?:    string
  /** `danger` styles the confirm button in the app's danger palette. */
  tone?:           ConfirmSheetTone
  /** Button stack direction. `'row'` (default) is the historical side-
   *  by-side layout. `'column'` stacks confirm above cancel — used for
   *  destructive confirms on tall phones (iPhone 14 Pro+) where the
   *  bottom-of-sheet position is the thumb's natural rest zone:
   *  putting Cancel there means accidental brushes go to the safe
   *  branch, while the destructive button requires deliberate upward
   *  travel. iOS native Action Sheets follow the same convention. */
  layout?:         ConfirmSheetLayout
  /** Async-friendly flag — disables both buttons while the action runs. */
  loading?:        boolean
  onClose:         () => void
  onConfirm:       () => void
}

export default function ConfirmSheet({
  isOpen, title, description, icon,
  confirmLabel, cancelLabel = 'キャンセル',
  tone = 'neutral', layout = 'row', loading = false,
  onClose, onConfirm,
}: Props) {
  if (!isOpen) return null

  const confirmClass = tone === 'danger'
    ? 'border-[#E9C5C5] bg-danger-pale text-[#A04040] hover:brightness-95'
    : 'border-accent bg-accent text-white hover:brightness-110'

  // In column mode the confirm button is rendered first (above cancel)
  // so the destructive action is visually + ergonomically separated
  // from the bottom-of-screen safe-default position.
  const stackClass = layout === 'column' ? 'flex flex-col gap-2' : 'flex gap-2.5'

  const cancelBtn = (
    <button
      onClick={onClose}
      disabled={loading}
      className={[
        layout === 'column' ? 'w-full' : 'flex-1',
        'h-12 rounded-xl border border-border bg-app text-ink text-[13px] font-semibold cursor-pointer hover:bg-tile transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
      ].join(' ')}
    >
      {cancelLabel}
    </button>
  )

  const confirmBtn = (
    <button
      onClick={onConfirm}
      disabled={loading}
      className={[
        layout === 'column' ? 'w-full' : 'flex-1',
        'h-12 rounded-xl border text-[13px] font-bold cursor-pointer',
        'active:scale-[0.98] transition-all',
        'disabled:opacity-60 disabled:cursor-not-allowed',
        'flex items-center justify-center gap-1.5',
        confirmClass,
      ].join(' ')}
    >
      {confirmLabel}
    </button>
  )

  return (
    <BottomSheet isOpen onClose={onClose} title={title}>
      <div className="py-2">
        {icon && (
          <div className="flex justify-center mb-3">
            {icon}
          </div>
        )}
        {description && (
          <div className="m-0 mb-5 text-[13px] text-ink leading-[1.7] tracking-[0.02em] text-center">
            {description}
          </div>
        )}
        <div className={stackClass}>
          {layout === 'column' ? (<>{confirmBtn}{cancelBtn}</>) : (<>{cancelBtn}{confirmBtn}</>)}
        </div>
      </div>
    </BottomSheet>
  )
}
