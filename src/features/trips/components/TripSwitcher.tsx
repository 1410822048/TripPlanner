// src/features/trips/components/TripSwitcher.tsx
import { useState, useRef, useEffect } from 'react'
import { Plus, ChevronDown } from 'lucide-react'
import SwipeableTripItem from './SwipeableTripItem'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { toast } from '@/shared/toast'
import type { TripItem, MenuActionKey } from '@/features/trips/types'

const MENU_ACTIONS: { key: MenuActionKey; emoji: string; label: string; sub: string; danger: boolean }[] = [
  { key:'edit',     emoji:'✏️',  label:'編輯行程資訊', sub:'修改名稱・日期・目的地', danger:false },
  { key:'members',  emoji:'👥',  label:'管理成員',     sub:'邀請・移除旅伴',         danger:false },
  { key:'copy',     emoji:'📋',  label:'複製行程',     sub:'建立此行程的副本',        danger:false },
  { key:'share',    emoji:'🔗',  label:'分享行程',     sub:'產生邀請連結',            danger:false },
  { key:'settings', emoji:'⚙️',  label:'行程設定',     sub:'幣別・時區・隱私',        danger:false },
]

interface TripSwitcherProps {
  trips:         TripItem[]
  selected:      TripItem
  onSelect:      (trip: TripItem) => void
  onAction:      (key: MenuActionKey) => void
  onDelete:      (tripId: string) => void
  onReorder:     (fromIdx: number, toIdx: number) => void
  onCreateTrip?: () => void
  /**
   * When true, the last remaining trip can be deleted. Cloud mode sets this
   * because the parent renders `EmptyTrips` at `length === 0`. Demo mode
   * leaves it off — `useTripSelection` relies on a non-empty `trips[0]!`.
   */
  canDeleteLast?: boolean
}

export default function TripSwitcher({
  trips, selected, onSelect, onAction, onDelete, onReorder, onCreateTrip,
  canDeleteLast = false,
}: TripSwitcherProps) {
  const [open, setOpen] = useState(false)
  const swipe = useSwipeOpen()

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragY, setDragY] = useState(0)
  const [itemHeight, setItemHeight] = useState(55)

  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // When the dropdown closes (any path: outside-click, select, action,
  // create), drop any pending swipe so reopening shows fresh state instead
  // of the previously-swiped row stuck open.
  useEffect(() => {
    if (!open) swipe.closeAll()
  }, [open, swipe])

  const isReordering = draggingId !== null

  function computeTargetIdx(fromIdx: number): number {
    const offset = Math.round(dragY / itemHeight)
    return Math.max(0, Math.min(trips.length - 1, fromIdx + offset))
  }

  function startReorder(id: string, measuredHeight: number) {
    swipe.closeAll()
    setDraggingId(id)
    setDragY(0)
    setItemHeight(measuredHeight || 55)
  }
  function moveReorder(dy: number) { setDragY(dy) }
  function endReorder() {
    if (!draggingId) return
    const fromIdx = trips.findIndex(t => t.id === draggingId)
    if (fromIdx !== -1) {
      const toIdx = computeTargetIdx(fromIdx)
      if (toIdx !== fromIdx) onReorder(fromIdx, toIdx)
    }
    setDraggingId(null)
    setDragY(0)
  }

  function computeShift(itemId: string): number {
    if (!draggingId || draggingId === itemId) return 0
    const fromIdx = trips.findIndex(t => t.id === draggingId)
    const itemIdx = trips.findIndex(t => t.id === itemId)
    if (fromIdx === -1 || itemIdx === -1) return 0
    const toIdx = computeTargetIdx(fromIdx)
    if (itemIdx > fromIdx && itemIdx <= toIdx) return -itemHeight
    if (itemIdx < fromIdx && itemIdx >= toIdx) return itemHeight
    return 0
  }

  return (
    <div ref={ref} className="relative">

      {/* Trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`現在の旅程: ${selected.title}、切り替えメニューを開く`}
        className={[
          'w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl cursor-pointer transition-all',
          'border-[1.5px]',
          open
            ? 'border-pick bg-pick-pale shadow-[0_0_0_3px_var(--color-pick-pale)]'
            : 'border-border bg-surface shadow-[0_1px_6px_rgba(0,0,0,0.06)] hover:border-muted',
        ].join(' ')}
      >
        <div
          className={[
            'w-10 h-10 rounded-xl shrink-0 flex items-center justify-center text-[20px] transition-colors',
            'shadow-[inset_0_1px_3px_rgba(0,0,0,0.06)]',
            open ? 'bg-pick' : 'bg-tile',
          ].join(' ')}
        >
          {selected.emoji}
        </div>

        <div className="flex-1 min-w-0 text-left">
          <div className={[
            'text-[10px] font-bold tracking-[0.12em] uppercase mb-0.5',
            open ? 'text-pick' : 'text-muted',
          ].join(' ')}>
            旅の記録
          </div>
          <div className={[
            'text-[15px] font-extrabold -tracking-[0.3px] overflow-hidden text-ellipsis whitespace-nowrap',
            open ? 'text-pick' : 'text-ink',
          ].join(' ')}>
            {selected.title}
          </div>
        </div>

        <div className={[
          'flex items-center gap-[3px] px-2 py-1 rounded-card text-[10px] font-semibold tracking-[0.04em] shrink-0 transition-all',
          open ? 'bg-pick text-white' : 'bg-app text-muted',
        ].join(' ')}>
          {open ? '収む' : '切替'}
          <ChevronDown
            size={12} strokeWidth={2.5}
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Dropdown */}
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[150]"
            style={{
              background: 'rgba(28, 22, 18, 0.34)',
              backdropFilter: 'blur(4px) saturate(140%)',
              WebkitBackdropFilter: 'blur(4px) saturate(140%)',
              animation: 'backdropIn 0.22s cubic-bezier(0.32,0.72,0,1)',
            }}
          />

          <div
            // Click anywhere inside the dropdown that's not a row's interactive
            // element closes any open swipe. Row buttons stopPropagation so
            // this only fires for taps on the header / gaps / surrounding gaps.
            onClick={swipe.closeAll}
            className="absolute top-[calc(100%+8px)] left-0 right-0 bg-surface border border-border rounded-card z-[151] overflow-hidden"
            style={{
              boxShadow: '0 20px 56px rgba(0,0,0,0.22), 0 6px 16px rgba(0,0,0,0.10)',
              animation: 'dropIn 0.22s cubic-bezier(0.32,0.72,0,1)',
            }}
          >

            <div className="px-2.5 pt-3 pb-2">
              <div className="flex items-center justify-between px-1.5 pb-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px]">🗂️</span>
                  <span className="text-[10px] font-bold text-muted tracking-[0.1em] uppercase">
                    マイ旅程
                  </span>
                </div>
                <span className="text-[9.5px] text-muted font-semibold">
                  {trips.length} 件
                </span>
              </div>

              <div
                className="thin-scrollbar mb-1.5 pr-0.5 relative max-h-[220px]"
                style={{ overflowY: isReordering ? 'hidden' : 'auto' }}
              >
                {trips.map(trip => (
                  <SwipeableTripItem
                    key={trip.id}
                    trip={trip}
                    isActive={trip.id === selected.id}
                    {...swipe.bindRow(trip.id)}
                    canDelete={trips.length > 1 || canDeleteLast}
                    canReorder={trips.length > 1}
                    isDragging={draggingId === trip.id}
                    dragY={draggingId === trip.id ? dragY : 0}
                    shiftY={computeShift(trip.id)}
                    onSelect={() => { onSelect(trip); setOpen(false); swipe.closeAll() }}
                    onDelete={() => { onDelete(trip.id); swipe.closeAll() }}
                    onReorderStart={(h) => startReorder(trip.id, h)}
                    onReorderMove={moveReorder}
                    onReorderEnd={endReorder}
                  />
                ))}
              </div>

              <button
                onClick={() => {
                  if (onCreateTrip) onCreateTrip()
                  else toast.info('新しい旅の追加は開発中です')
                  setOpen(false)
                }}
                className="w-full h-10 rounded-xl border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12.5px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-pick-pale hover:border-pick hover:text-pick"
              >
                <Plus size={14} strokeWidth={2.5} />
                新しい旅を追加
              </button>
            </div>

            <div className="mx-3 my-1 border-t border-dashed border-border" />

            <div className="px-2.5 pt-1.5 pb-3">
              <div className="flex items-center gap-1.5 px-1.5 pb-2">
                <span className="text-[13px]">⚙️</span>
                <span className="text-[10px] font-bold text-muted tracking-[0.1em] uppercase">
                  管理
                </span>
              </div>
              {MENU_ACTIONS.map(({ key, emoji, label, sub, danger }) => (
                <button
                  key={key}
                  onClick={() => { onAction(key); setOpen(false) }}
                  className={[
                    'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl border-none bg-transparent cursor-pointer text-left transition-colors',
                    danger ? 'hover:bg-danger-pale' : 'hover:bg-app',
                  ].join(' ')}
                >
                  <div className={[
                    'w-[34px] h-[34px] rounded-input shrink-0 flex items-center justify-center text-[16px]',
                    danger ? 'bg-danger-pale' : 'bg-tile',
                  ].join(' ')}>
                    {emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={[
                      'text-[13px] font-semibold',
                      danger ? 'text-[#A04040]' : 'text-ink',
                    ].join(' ')}>
                      {label}
                    </div>
                    <div className={[
                      'text-[10.5px] mt-px',
                      danger ? 'text-[#C07070]' : 'text-muted',
                    ].join(' ')}>
                      {sub}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
