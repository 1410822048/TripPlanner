// src/features/account/components/NotificationInboxButton.tsx
// Header entry for the in-app notification inbox. Stays separate from
// browser push settings so the bell always means "messages". Owns the
// single realtime listener for both the unread dot and the sheet contents,
// so opening the sheet costs zero extra Firestore reads.
import { useState } from 'react'
import { Bell } from 'lucide-react'
import NotificationInboxSheet from './NotificationInboxSheet'
import { useNotifications } from '../hooks/useNotifications'

interface Props {
  uid: string
  accessibleTripIds: readonly string[] | undefined
}

export default function NotificationInboxButton({ uid, accessibleTripIds }: Props) {
  const [open, setOpen] = useState(false)
  const { data: notifications } = useNotifications(uid, accessibleTripIds)
  const visibleNotifications = notifications ?? []
  const hasUnread = visibleNotifications.some(n => n.readAt == null)

  return (
    <>
      <button
        type="button"
        aria-label={hasUnread ? '通知ボックス(未読あり)' : '通知ボックス'}
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
        {hasUnread && (
          <span
            aria-hidden
            className="absolute top-1.5 right-2 w-[9px] h-[9px] rounded-full bg-danger border-2 border-app"
          />
        )}
      </button>

      <NotificationInboxSheet
        isOpen={open}
        onClose={() => setOpen(false)}
        uid={uid}
        notifications={visibleNotifications}
      />
    </>
  )
}
