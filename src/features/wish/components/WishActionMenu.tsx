// src/features/wish/components/WishActionMenu.tsx
// Discoverable ⋮ overflow trigger → bottom-sheet menu for a single
// wish card. Two visual states:
//   1. Action list — 編集 / 削除 buttons gated per role.
//   2. Confirm    — handed off to ConfirmSheet in column layout
//                   (destructive on top, Cancel at bottom for thumb-zone).
//
// "Menu of one" shortcut: when the viewer only has 削除 available (trip
// owner inspecting someone else's wish), we skip the action-list step
// entirely and go straight to confirm — a one-item action sheet feels
// disconnected on tall phones (button far from the title with empty
// space between).
import { useState } from 'react'
import { Pencil, Trash2, AlertTriangle } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import ConfirmSheet from '@/components/ui/ConfirmSheet'
import type { Wish } from '@/types'

interface Props {
  isOpen:    boolean
  wish:      Wish
  canEdit:   boolean
  canDelete: boolean
  onEdit:    () => void
  onDelete:  () => void
  onClose:   () => void
}

export default function WishActionMenu({
  isOpen, wish, canEdit, canDelete, onEdit, onDelete, onClose,
}: Props) {
  const skipActionList = canDelete && !canEdit
  const [userConfirming, setUserConfirming] = useState(false)
  // `confirming` is derived — `skipActionList` always pins us to the
  // confirm state, otherwise the user's explicit tap on 削除 raises
  // `userConfirming`. Avoids the seed-from-prop antipattern that
  // breaks if the parent ever stops unmounting us on close.
  const confirming = skipActionList || userConfirming

  if (!isOpen) return null

  if (confirming) {
    return (
      <ConfirmSheet
        isOpen
        title="要刪除嗎？"
        layout="column"
        tone="danger"
        confirmLabel="刪除"
        icon={
          <span className="w-9 h-9 rounded-full bg-danger-pale flex items-center justify-center">
            <AlertTriangle size={18} strokeWidth={2.2} className="text-danger" />
          </span>
        }
        description={
          <>
            <div className="text-[14px] font-semibold text-ink leading-[1.5] break-words">
              刪除「{wish.title}」
            </div>
            <div className="text-[11.5px] text-muted mt-1 leading-[1.5]">
              此操作無法復原，投票也會一併刪除。
            </div>
          </>
        }
        onConfirm={() => { onDelete(); onClose() }}
        // Cancel: bounce back to the action list when we entered confirm
        // via 削除 tap; close the whole menu when this was a one-shot
        // skip (no list to fall back to).
        onClose={() => skipActionList ? onClose() : setUserConfirming(false)}
      />
    )
  }

  return (
    <BottomSheet isOpen onClose={onClose} title="操作">
      <div className="flex flex-col gap-1.5">
        {canEdit && (
          <button
            type="button"
            onClick={() => { onClose(); onEdit() }}
            className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-border/40 transition-colors"
          >
            <Pencil size={18} strokeWidth={2} className="text-ink shrink-0" />
            <span className="text-[14.5px] text-ink font-medium">編輯</span>
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={() => setUserConfirming(true)}
            className="flex items-center gap-3 px-3 min-h-12 py-2 rounded-input bg-app border-none cursor-pointer text-left active:bg-danger-pale transition-colors"
          >
            <Trash2 size={18} strokeWidth={2} className="text-danger shrink-0" />
            <span className="text-[14.5px] text-danger font-medium">刪除</span>
          </button>
        )}
      </div>
    </BottomSheet>
  )
}
