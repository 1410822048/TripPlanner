// src/features/account/components/NotificationInboxSheet.tsx
// Inbox content for NotificationInboxButton's BottomSheet: filter controls,
// row list, and empty states. Opening the sheet does NOT mark anything read
// -- only tapping a row (that one) or "すべて既読" (all currently-unread) does,
// per the P2 spec.
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Receipt, Ticket, Wallet, UserPlus, Inbox, CheckCheck, CalendarClock, Heart, ListChecks, Plane } from 'lucide-react'
import BottomSheet from '@/components/ui/BottomSheet'
import SwipeableShell from '@/components/ui/SwipeableShell'
import { markNotificationRead, markAllNotificationsRead, dismissNotification } from '../services/notificationService'
import { captureError } from '@/services/sentry'
import { useTripStore } from '@/store/tripStore'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import type { Notification, NotificationEntityType } from '@/types'

interface Props {
  isOpen: boolean
  onClose: () => void
  uid: string
  notifications: Notification[]
}

type NotificationFilter = 'all' | 'unread'

const ENTITY_META: Record<NotificationEntityType, {
  icon: typeof Receipt
  iconClass: string
  iconBgClass: string
}> = {
  expense:    { icon: Receipt,       iconClass: 'text-warn',   iconBgClass: 'bg-warn-bg' },
  booking:    { icon: Ticket,        iconClass: 'text-pick',   iconBgClass: 'bg-pick-pale' },
  settlement: { icon: Wallet,        iconClass: 'text-teal',   iconBgClass: 'bg-teal-pale' },
  member:     { icon: UserPlus,      iconClass: 'text-accent', iconBgClass: 'bg-accent-pale' },
  schedule:   { icon: CalendarClock, iconClass: 'text-accent', iconBgClass: 'bg-accent-pale' },
  wish:       { icon: Heart,         iconClass: 'text-danger', iconBgClass: 'bg-danger-pale' },
  planning:   { icon: ListChecks,    iconClass: 'text-teal',   iconBgClass: 'bg-teal-pale' },
  trip:       { icon: Plane,         iconClass: 'text-warn',   iconBgClass: 'bg-warn-bg' },
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
  const [filter, setFilter] = useState<NotificationFilter>('all')
  // Optimistically hide a dismissed row until the server snapshot drops it
  // (query filters dismissedAt == null). On write failure the id is removed
  // so the row reappears — no toast, per spec.
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set())
  const swipe = useSwipeOpen()

  // This component stays mounted while the sheet is closed (BottomSheet only
  // unmounts its children), so a row swiped open before closing would render
  // open on reopen. Reset the open-row state on every open/close transition.
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen)
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen)
    swipe.closeAll()
  }

  const activeNotifications = notifications.filter(n => !dismissingIds.has(n.id))
  const unreadNotifications = activeNotifications.filter(n => n.readAt == null)
  const unreadIds = unreadNotifications.map(n => n.id)
  const unreadCount = unreadNotifications.length
  const visibleNotifications = filter === 'unread'
    ? unreadNotifications
    : activeNotifications

  async function handleRowClick(n: Notification) {
    onClose()
    // Account-scoped rows (member.removed_self) point at a trip the user can no
    // longer access — never switch into it. Their route is /account.
    if (n.scope !== 'account') setSelectedTripId(n.tripId)
    if (n.readAt == null) {
      markNotificationRead(uid, n.id).catch(e => captureError(e, { source: 'NotificationInboxSheet.markRead', notificationId: n.id }))
    }
    if (!pathname.startsWith(n.route)) navigate(n.route)
  }

  function handleDismiss(n: Notification) {
    setDismissingIds(prev => new Set(prev).add(n.id))
    dismissNotification(uid, n).catch(e => {
      captureError(e, { source: 'NotificationInboxSheet.dismiss', notificationId: n.id })
      setDismissingIds(prev => { const next = new Set(prev); next.delete(n.id); return next })
    })
  }

  function handleMarkAllRead() {
    swipe.closeAll()
    markAllNotificationsRead(uid, unreadIds).catch(e => captureError(e, { source: 'NotificationInboxSheet.markAllRead', uid }))
  }

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <span>通知ボックス</span>
          {unreadCount > 0 && (
            <span className="shrink-0 rounded-full bg-danger px-2 py-0.5 text-[10.5px] font-bold leading-none text-white">
              {unreadCount}件未読
            </span>
          )}
        </span>
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex shrink-0 items-center gap-1 rounded-chip border border-border bg-app p-1">
          {(['all', 'unread'] as const).map(mode => {
            const active = filter === mode
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => { swipe.closeAll(); setFilter(mode) }}
                className={[
                  'flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  active ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.08)]' : 'bg-transparent text-muted hover:text-ink',
                ].join(' ')}
              >
                {mode === 'all' ? 'すべて' : '未読'}
                {mode === 'unread' && unreadCount > 0 && (
                  <span aria-hidden className="h-2 w-2 rounded-full bg-danger" />
                )}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={handleMarkAllRead}
          disabled={unreadCount === 0}
          className={[
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            unreadCount > 0
              ? 'text-accent hover:bg-accent-pale cursor-pointer'
              : 'text-muted/60 cursor-not-allowed',
          ].join(' ')}
        >
          <CheckCheck size={13} strokeWidth={2.4} aria-hidden />
          すべて既読
        </button>
      </div>

      {visibleNotifications.length === 0 ? (
        <div className="rounded-card border border-border bg-app px-4 py-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-surface flex items-center justify-center text-muted">
            <Inbox size={21} strokeWidth={2} aria-hidden />
          </div>
          <div className="mt-3 text-[14px] font-black text-ink -tracking-[0.1px]">
            {filter === 'unread' ? '未読はありません' : '通知はありません'}
          </div>
          <div className="mt-1 text-[12px] leading-[1.6] text-muted">
            {filter === 'unread'
              ? '新しい通知はすべて確認済みです。'
              : '新しい更新が届くとここに表示されます'}
          </div>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0" role="list">
          {visibleNotifications.map(n => {
            const meta = ENTITY_META[n.entityType]
            const Icon = meta.icon
            const unread = n.readAt == null
            return (
              <li key={n.id}>
                <SwipeableShell
                  className="rounded-card"
                  confirmDelete={false}
                  {...swipe.bindRow(n.id)}
                  onSelect={() => handleRowClick(n)}
                  onDelete={() => handleDismiss(n)}
                >
                  {({ selectButtonProps }) => (
                    <button
                      {...selectButtonProps}
                      className={[
                        'grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-card border px-3.5 py-3 text-left transition-colors',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                        unread
                          ? 'border-danger-soft bg-danger-pale/35 hover:bg-danger-pale/55'
                          : 'border-border bg-app hover:bg-tile',
                      ].join(' ')}
                    >
                      <span className={[
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                        meta.iconBgClass,
                        meta.iconClass,
                      ].join(' ')}>
                        <Icon size={17} strokeWidth={2.1} aria-hidden />
                      </span>

                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-bold leading-[1.4] text-ink">{n.title}</span>
                        <span className="mt-0.5 block truncate text-[10.5px] font-semibold text-accent">{n.tripTitle}</span>
                        <span className="mt-1 block text-[12px] leading-[1.55] text-muted line-clamp-2">{n.body}</span>
                      </span>

                      <span className="flex shrink-0 items-center gap-2 pt-0.5">
                        <span className="text-[10.5px] leading-none text-muted">{relativeTime(n.createdAt.toDate())}</span>
                        {unread && <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-danger" />}
                      </span>
                    </button>
                  )}
                </SwipeableShell>
              </li>
            )
          })}
        </ul>
      )}
    </BottomSheet>
  )
}
