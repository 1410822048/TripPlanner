// src/features/trips/components/TripSwitcher.tsx
import { useState, useRef, useEffect } from 'react'
import { Plus, ChevronDown } from 'lucide-react'
import SwipeableTripItem from './SwipeableTripItem'
import { useSwipeOpen } from '@/hooks/useSwipeOpen'
import { toast } from '@/shared/toast'
import type { TripItem, MenuActionKey } from '@/features/trips/types'

// `ownerOnly` gates entries that only the trip owner can usefully
// invoke — e.g. editing trip metadata or generating invite links both
// route through firestore.rules `isTripOwner` writes, so showing them
// to editors/viewers would result in a "更新失敗" toast or an empty
// invite list. Hiding them up-front keeps "if you can see it you can
// use it" intact. The MembersModal handles the fine-grained "owner
// can manage, others view-only" distinction itself, so 'members' stays
// visible to everyone.
const MENU_ACTIONS: {
  key:       MenuActionKey
  emoji:     string
  label:     string
  sub:       string
  danger:    boolean
  ownerOnly: boolean
}[] = [
  { key:'edit',     emoji:'✏️',  label:'編輯行程資訊', sub:'名稱・日期・目的地・幣別', danger:false, ownerOnly:true  },
  { key:'members',  emoji:'👥',  label:'管理成員',     sub:'邀請・移除旅伴',           danger:false, ownerOnly:false },
  { key:'copy',     emoji:'📋',  label:'複製行程',     sub:'建立此行程的副本',          danger:false, ownerOnly:false },
  { key:'share',    emoji:'🔗',  label:'分享行程',     sub:'產生邀請連結',              danger:false, ownerOnly:true  },
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
  /**
   * True when the signed-in user owns the selected trip. Drives the
   * `ownerOnly` filter on MENU_ACTIONS so editors / viewers don't see
   * options that would error out in firestore.rules. Defaults to true
   * for demo mode (no real ownership concept).
   */
  isOwner?:      boolean
}

export default function TripSwitcher({
  trips, selected, onSelect, onAction, onDelete, onReorder, onCreateTrip,
  canDeleteLast = false,
  isOwner = true,
}: TripSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  // Effective edit visibility ties to trips.length > 1 — same guard the
  // toggle button uses. Decouples the "edit mode is on" intent from the
  // "edit chrome can render" condition: when a delete drops trips to 1,
  // the toggle disappears but the rows would still render their trash
  // icons against this state — and clicking those would delete the last
  // trip immediately (canDelete still true under canDeleteLast). Deriving
  // it here keeps both gates honest.
  const editVisible = editMode && trips.length > 1
  const swipe = useSwipeOpen()

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragY, setDragY] = useState(0)
  const [itemHeight, setItemHeight] = useState(55)

  const ref = useRef<HTMLDivElement>(null)

  // Single close handler — every path that closes the dropdown calls
  // this, replacing what used to be a `useEffect` that watched `open`
  // and reset side states on transition. The effect approach tripped
  // react-hooks/set-state-in-effect (rightly: it was a state→state
  // cascade rather than syncing to an external system). Centralising
  // here is the React-19-idiomatic fix: the "reopen-fresh" contract
  // is enforced at every flip point instead of converging in a watcher.
  function closeDropdown() {
    setOpen(false)
    swipe.closeAll()
    setEditMode(false)
  }

  useEffect(() => {
    if (!open) return  // only need the outside-click listener while open
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Inline rather than calling closeDropdown so the effect's dep
        // array stays at [open] — pulling closeDropdown in would mean
        // the listener re-registers on every render (closeDropdown's
        // identity changes with each render in non-compiler-memoised
        // form). setState refs are themselves stable.
        setOpen(false)
        swipe.closeAll()
        setEditMode(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
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
        onClick={() => open ? closeDropdown() : setOpen(true)}
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
            onClick={closeDropdown}
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
                  <span className="text-[9.5px] text-muted font-semibold">
                    {trips.length} 件
                  </span>
                </div>
                {/* Edit toggle — gated by trips.length > 1 so the affordance
                    only appears when there's something meaningful to reorder
                    or compare-and-delete. */}
                {trips.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditMode(e => !e)
                      swipe.closeAll()
                    }}
                    className={[
                      'text-[10.5px] font-semibold tracking-[0.04em] px-2 py-0.5 rounded-card border-none cursor-pointer transition-colors',
                      editMode ? 'bg-pick text-white' : 'bg-app text-pick hover:bg-pick-pale',
                    ].join(' ')}
                  >
                    {editMode ? '完了' : '編集'}
                  </button>
                )}
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
                    // Per-trip ownership gate: only the trip owner can
                    // delete (firestore.rules `isTripOwner`). Non-owned
                    // trips render without the swipe affordance and
                    // without the red delete background. The
                    // count-based guard still applies on top so the
                    // demo last-trip stays undeletable.
                    canDelete={trip.ownedByMe && (trips.length > 1 || canDeleteLast)}
                    canReorder={trips.length > 1}
                    isDragging={draggingId === trip.id}
                    dragY={draggingId === trip.id ? dragY : 0}
                    shiftY={computeShift(trip.id)}
                    editMode={editVisible}
                    onSelect={() => { onSelect(trip); closeDropdown() }}
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
                  closeDropdown()
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
              {MENU_ACTIONS.filter(a => isOwner || !a.ownerOnly).map(({ key, emoji, label, sub, danger }) => (
                <button
                  key={key}
                  onClick={() => { onAction(key); closeDropdown() }}
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
