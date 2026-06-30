// src/features/account/components/NotificationInboxButton.tsx
// Header entry for the future in-app notification inbox. It stays separate
// from browser push settings so the bell always means "messages".
import { useState } from 'react'
import { Bell, Inbox } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'

export default function NotificationInboxButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label="通知ボックス"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={[
          'relative w-11 h-11 rounded-full bg-accent-pale text-accent',
          'flex items-center justify-center shrink-0 cursor-pointer',
          'shadow-[0_2px_8px_rgba(74,102,112,0.14)] transition-all',
          'hover:bg-accent-pale/80 active:scale-[0.97]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        ].join(' ')}
      >
        <Bell size={18} strokeWidth={2} aria-hidden />
      </button>

      <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="通知ボックス">
        <div className="rounded-card border border-border bg-app px-4 py-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-surface flex items-center justify-center text-muted">
            <Inbox size={21} strokeWidth={2} aria-hidden />
          </div>
          <div className="mt-3 text-[14px] font-black text-ink -tracking-[0.1px]">
            通知はありません
          </div>
          <div className="mt-1 text-[12px] leading-[1.6] text-muted">
            新しい更新が届くとここに表示されます
          </div>
        </div>
      </BottomSheet>
    </>
  )
}
