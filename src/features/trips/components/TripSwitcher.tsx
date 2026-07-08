// src/features/trips/components/TripSwitcher.tsx
import { useState, useRef, useEffect } from 'react'
import {
  ChevronDown,
  Copy,
  FolderOpen,
  Link,
  PencilLine,
  Plus,
  QrCode,
  Settings,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
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
  icon:      LucideIcon
  label:     string
  sub:       string
  danger:    boolean
  ownerOnly: boolean
}[] = [
  { key:'edit',     icon:PencilLine, label:'編輯行程資訊', sub:'名稱・日期・目的地・幣別', danger:false, ownerOnly:true  },
  { key:'members',  icon:UsersRound, label:'管理成員',     sub:'邀請・移除旅伴',           danger:false, ownerOnly:false },
  { key:'copy',     icon:Copy,       label:'複製行程',     sub:'建立此行程的副本',          danger:false, ownerOnly:false },
  { key:'share',    icon:Link,       label:'分享行程',     sub:'產生邀請連結',              danger:false, ownerOnly:true  },
]

interface TripSwitcherProps {
  trips:         TripItem[]
  selected:      TripItem
  onSelect:      (trip: TripItem) => void
  onAction:      (key: MenuActionKey) => void
  onDelete:      (tripId: string) => void
  onReorder:     (fromIdx: number, toIdx: number) => void
  onCreateTrip?: () => void
  onScanInvite?: () => void
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
  onScanInvite,
  canDeleteLast = false,
  isOwner = true,
}: TripSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  // Tied to trips.length > 1 so that a delete dropping trips to 1 immediately
  // hides edit chrome — otherwise lingering trash icons could delete the
  // last trip (canDelete still true under canDeleteLast).
  const editVisible = editMode && trips.length > 1
  const swipe = useSwipeOpen()

  const [draggingId, setDraggingId] = useState<string | null>(null)
  // dragY lives in a ref + CSS variable so the per-pointermove update
  // doesn't re-render TripSwitcher + every SwipeableTripItem 60–120Hz.
  // The dragged row reads `var(--drag-y)` directly for smooth visual
  // follow; only crossing a row threshold (discrete) bumps `targetIdx`
  // state, which triggers a single React render that shifts the
  // neighbour rows.
  const dragYRef = useRef(0)
  const [targetIdx, setTargetIdx] = useState<number | null>(null)
  const [itemHeight, setItemHeight] = useState(55)

  const ref = useRef<HTMLDivElement>(null)

  // Every close path calls this. Replaced the previous useEffect-on-open
  // cascade (state→state sync is what react-hooks/set-state-in-effect
  // rightly flags); centralising at the flip points keeps the
  // "reopen-fresh" contract local.
  function closeDropdown() {
    setOpen(false)
    swipe.closeAll()
    setEditMode(false)
  }

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        // Inlined (not closeDropdown call) so the effect deps stay [open] —
        // closeDropdown's identity changes per render and would re-register
        // the listener.
        setOpen(false)
        swipe.closeAll()
        setEditMode(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, swipe])

  const isReordering = draggingId !== null

  function clampTargetIdx(fromIdx: number, dy: number): number {
    const offset = Math.round(dy / itemHeight)
    return Math.max(0, Math.min(trips.length - 1, fromIdx + offset))
  }

  function startReorder(id: string, measuredHeight: number) {
    swipe.closeAll()
    setDraggingId(id)
    dragYRef.current = 0
    setTargetIdx(trips.findIndex(t => t.id === id))
    setItemHeight(measuredHeight || 55)
    if (ref.current) ref.current.style.setProperty('--drag-y', '0px')
  }
  function moveReorder(dy: number) {
    dragYRef.current = dy
    // Imperative: smooth per-frame transform for the dragged row only,
    // via inherited CSS custom property — bypasses React reconciliation.
    if (ref.current) ref.current.style.setProperty('--drag-y', `${dy}px`)
    // Discrete: only flip targetIdx when crossing a row threshold so
    // neighbour rows re-render at most a handful of times per drag.
    if (!draggingId) return
    const fromIdx = trips.findIndex(t => t.id === draggingId)
    if (fromIdx === -1) return
    const nextTarget = clampTargetIdx(fromIdx, dy)
    if (nextTarget !== targetIdx) setTargetIdx(nextTarget)
  }
  function endReorder() {
    if (!draggingId) return
    const fromIdx = trips.findIndex(t => t.id === draggingId)
    const toIdx   = targetIdx ?? fromIdx
    if (fromIdx !== -1 && toIdx !== fromIdx) onReorder(fromIdx, toIdx)
    setDraggingId(null)
    setTargetIdx(null)
    dragYRef.current = 0
    if (ref.current) ref.current.style.removeProperty('--drag-y')
  }

  function computeShift(itemId: string): number {
    if (!draggingId || draggingId === itemId || targetIdx === null) return 0
    const fromIdx = trips.findIndex(t => t.id === draggingId)
    const itemIdx = trips.findIndex(t => t.id === itemId)
    if (fromIdx === -1 || itemIdx === -1) return 0
    if (itemIdx > fromIdx && itemIdx <= targetIdx) return -itemHeight
    if (itemIdx < fromIdx && itemIdx >= targetIdx) return itemHeight
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
                  <FolderOpen size={13} strokeWidth={2.2} className="text-pick" aria-hidden="true" />
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
                className="mb-1.5 h-10 w-full rounded-xl border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12.5px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-pick-pale hover:border-pick hover:text-pick"
              >
                <Plus size={14} strokeWidth={2.5} />
                新しい旅
              </button>
            </div>

            <div className="mx-3 my-1 border-t border-dashed border-border" />

            <div className="px-2.5 pt-1.5 pb-3">
              <div className="flex items-center gap-1.5 px-1.5 pb-2">
                <Settings size={13} strokeWidth={2.2} className="text-pick" aria-hidden="true" />
                <span className="text-[10px] font-bold text-muted tracking-[0.1em] uppercase">
                  管理
                </span>
              </div>
              {onScanInvite && (
                <button
                  onClick={() => {
                    onScanInvite()
                    closeDropdown()
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl border-none bg-transparent cursor-pointer text-left transition-colors hover:bg-app"
                >
                  <div className="w-[34px] h-[34px] rounded-input shrink-0 flex items-center justify-center bg-tile">
                    <QrCode
                      size={17}
                      strokeWidth={2.2}
                      className="text-pick"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink">
                      QRコードで参加
                    </div>
                    <div className="text-[10.5px] mt-px text-muted">
                      招待QRを読み取って旅に参加
                    </div>
                  </div>
                </button>
              )}
              {MENU_ACTIONS.filter(a => isOwner || !a.ownerOnly).map(({ key, icon: Icon, label, sub, danger }) => (
                <button
                  key={key}
                  onClick={() => { onAction(key); closeDropdown() }}
                  className={[
                    'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl border-none bg-transparent cursor-pointer text-left transition-colors',
                    danger ? 'hover:bg-danger-pale' : 'hover:bg-app',
                  ].join(' ')}
                >
                  <div className={[
                    'w-[34px] h-[34px] rounded-input shrink-0 flex items-center justify-center',
                    danger ? 'bg-danger-pale' : 'bg-tile',
                  ].join(' ')}>
                    <Icon
                      size={17}
                      strokeWidth={2.2}
                      className={danger ? 'text-danger' : 'text-pick'}
                      aria-hidden="true"
                    />
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
