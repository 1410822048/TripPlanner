// src/features/account/components/NotificationInboxSheet.tsx
// Inbox content for NotificationInboxButton's BottomSheet: row list, empty
// state, and a "すべて既読" footer. Opening the sheet does NOT mark
// anything read — only tapping a row (that one) or すべて既読 (all
// currently-unread) does, per the P2 spec.
import { useLocation, useNavigate } from 'react-router-dom'
import { Receipt, Ticket, Wallet, UserPlus, Inbox } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import { markNotificationRead, markAllNotificationsRead } from '../services/notificationService'
import { captureError } from '@/services/sentry'
import { useTripStore } from '@/store/tripStore'
import type { Notification, NotificationEntityType } from '@/types'

interface Props {
  isOpen: boolean
  onClose: () => void
  uid: string
  notifications: Notification[]
}

const ENTITY_ICON: Record<NotificationEntityType, typeof Receipt> = {
  expense:    Receipt,
  booking:    Ticket,
  settlement: Wallet,
  member:     UserPlus,
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' })

function relativeTime(date: Date): string {
  const diffSec = Math.round((date.getTime() - Date.now()) / 1000)
  const diffMin = Math.round(diffSec / 60)
  const diffHour = Math.round(diffMin / 60)
  const diffDay = Math.round(diffHour / 24)
  if (Math.abs(diffSec) < 60) return RELATIVE_TIME.format(diffSec, 'second')
  if (Math.abs(diffMin) < 60) return RELATIVE_TIME.format(diffMin, 'minute')
  if (Math.abs(diffHour) < 24) return RELATIVE_TIME.format(diffHour, 'hour')
  return RELATIVE_TIME.format(diffDay, 'day')
}

export default function NotificationInboxSheet({ isOpen, onClose, uid, notifications }: Props) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const setSelectedTripId = useTripStore(s => s.setSelectedTripId)
  const unreadIds = notifications.filter(n => n.readAt == null).map(n => n.id)

  async function handleRowClick(n: Notification) {
    onClose()
    setSelectedTripId(n.tripId)
    if (n.readAt == null) {
      markNotificationRead(uid, n.id).catch(e => captureError(e, { source: 'NotificationInboxSheet.markRead', notificationId: n.id }))
    }
    if (!pathname.startsWith(n.route)) navigate(n.route)
  }

  function handleMarkAllRead() {
    markAllNotificationsRead(uid, unreadIds).catch(e => captureError(e, { source: 'NotificationInboxSheet.markAllRead', uid }))
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="通知ボックス"
      footer={unreadIds.length > 0 && (
        <button
          type="button"
          onClick={handleMarkAllRead}
          className="w-full h-10 rounded-chip text-[13px] font-semibold text-accent bg-accent-pale cursor-pointer transition-colors hover:bg-accent-pale/80"
        >
          すべて既読にする
        </button>
      )}
    >
      {notifications.length === 0 ? (
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
      ) : (
        notifications.map(n => {
          const Icon = ENTITY_ICON[n.entityType]
          const unread = n.readAt == null
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => handleRowClick(n)}
              className={[
                'w-full flex items-start gap-3 rounded-card border border-border px-3.5 py-3 text-left cursor-pointer transition-colors',
                unread ? 'bg-accent-pale/40' : 'bg-app',
              ].join(' ')}
            >
              <div className="relative w-9 h-9 rounded-full bg-surface flex items-center justify-center shrink-0 text-muted">
                <Icon size={16} strokeWidth={2} aria-hidden />
                {unread && (
                  <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-danger border-2 border-app" aria-hidden />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-bold text-ink leading-[1.4]">{n.title}</div>
                    <div className="mt-0.5 text-[10.5px] font-semibold text-accent truncate">{n.tripTitle}</div>
                  </div>
                  <div className="text-[10.5px] text-muted shrink-0 pt-0.5">{relativeTime(n.createdAt.toDate())}</div>
                </div>
                <div className="mt-0.5 text-[12px] text-muted leading-[1.5] line-clamp-2">{n.body}</div>
              </div>
            </button>
          )
        })
      )}
    </BottomSheet>
  )
}
