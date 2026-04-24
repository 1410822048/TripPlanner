// src/features/schedule/components/SchedulePage.tsx
import { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule } from '../hooks/useSchedules'
import { useDeleteTrip, useMyTrips, useUpdateTrip } from '../hooks/useTrips'
import { useTripSelection } from '../hooks/useTripSelection'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useTripStore } from '@/store/tripStore'
import { useUid } from '@/hooks/useAuth'
import type { CreateScheduleInput, CreateTripInput, Schedule, Trip } from '@/types'
import type { MenuActionKey, TripItem } from '../types'
import { MOCK_SCHEDULES } from '../mocks'
import { buildDateRange, groupByDate } from '../utils'
import { toLocalDateString, fromLocalDateString } from '@/utils/dates'
import { toast } from '@/shared/toast'
import ScheduleFormModal from './ScheduleFormModal'
import EditTripModal from './EditTripModal'
import TripSwitcher from './TripSwitcher'
import TripHeaderCard from './TripHeaderCard'
import TimelineCard from './TimelineCard'
import CreateTripModal from './CreateTripModal'
import InviteModal from './InviteModal'
import MembersModal from './MembersModal'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import LoadingText from '@/components/ui/LoadingText'

// Adapter: Firestore Trip → presentation TripItem. `icon` is persisted on the
// Trip doc (default ✈️ for trips created before the field existed). Member
// chips come from useMembers separately.
function cloudTripToItem(trip: Trip): TripItem {
  return {
    id:        trip.id,
    title:     trip.title,
    dest:      trip.destination,
    emoji:     trip.icon ?? '✈️',
    startDate: toLocalDateString(trip.startDate.toDate()),
    endDate:   toLocalDateString(trip.endDate.toDate()),
    members:   [],
  }
}

export default function SchedulePage() {
  // Auth drives the mode split. While uid is undefined we render demo data
  // (even mid-load) so the initial paint is never a spinner — a key part of
  // the preview-first UX.
  const uid = useUid()
  const isDemo = !uid

  const { currentTrip, setCurrentTrip, recentTripIds } = useTripStore()
  const { data: myTrips, error: tripsError, refetch: refetchTrips } = useMyTrips(uid)

  const [activeDate,     setActiveDate]     = useState<string | null>(null)
  const [modalOpen,      setModalOpen]      = useState(false)
  const [editTarget,     setEditTarget]     = useState<Schedule | null>(null)
  const [editTripOpen,   setEditTripOpen]   = useState(false)
  const [createTripOpen, setCreateTripOpen] = useState(false)
  const [signInOpen,     setSignInOpen]     = useState(false)
  const [inviteOpen,     setInviteOpen]     = useState(false)
  const [membersOpen,    setMembersOpen]    = useState(false)

  const demoSelection = useTripSelection(() => setActiveDate(null))

  // Keep the Zustand `currentTrip` in sync with the TanStack Query cache. Three
  // things happen here:
  //   1. No trips → clear selection
  //   2. Selection still valid, but the cache entry has drifted (e.g. an
  //      optimistic updateTrip patch just landed) → replace with the latest
  //      object so the tile/title/dates re-render immediately
  //   3. No current selection, or selection points at a deleted trip →
  //      pick a persisted recent id, else the newest
  useEffect(() => {
    if (isDemo || !myTrips) return
    if (myTrips.length === 0) {
      if (currentTrip) setCurrentTrip(null)
      return
    }
    if (currentTrip) {
      const latest = myTrips.find(t => t.id === currentTrip.id)
      if (latest) {
        if (latest !== currentTrip) setCurrentTrip(latest)
        return
      }
      // falls through: current trip no longer in myTrips → reselect below
    }
    const recent = recentTripIds.map(id => myTrips.find(t => t.id === id)).find(Boolean)
    setCurrentTrip(recent ?? myTrips[0] ?? null)
  }, [isDemo, myTrips, currentTrip, recentTripIds, setCurrentTrip])

  // ─── Mode-specific state ───────────────────────────────────────
  const cloudTripItem = !isDemo && currentTrip ? cloudTripToItem(currentTrip) : null
  const cloudTripsList: TripItem[] = !isDemo ? (myTrips ?? []).map(cloudTripToItem) : []

  const tripId = isDemo ? demoSelection.selectedTrip.id : currentTrip?.id
  const { data: fbSchedules, isLoading } = useSchedules(isDemo ? undefined : tripId)
  const { data: fbMembers } = useMembers(isDemo ? undefined : tripId)
  const memberChips = useMemo(() => membersToTripMembers(fbMembers ?? []), [fbMembers])

  const schedules = isDemo
    ? (demoSelection.selectedTrip.id === 'demo' ? MOCK_SCHEDULES : [])
    : (fbSchedules ?? [])

  const trips        = isDemo ? demoSelection.trips        : cloudTripsList
  const selectedTrip = isDemo
    ? demoSelection.selectedTrip
    : (cloudTripItem ? { ...cloudTripItem, members: memberChips } : null)

  const createMut      = useCreateSchedule(tripId ?? '')
  const updateMut      = useUpdateSchedule(tripId ?? '')
  const deleteMut      = useDeleteSchedule(tripId ?? '')
  const updateTripMut  = useUpdateTrip(uid)
  const deleteTripMut  = useDeleteTrip(uid)
  const isSaving       = createMut.isPending || updateMut.isPending

  const selectTrip   = isDemo
    ? demoSelection.selectTrip
    : (item: TripItem) => {
        const next = myTrips?.find(t => t.id === item.id)
        if (next) { setCurrentTrip(next); setActiveDate(null) }
      }

  // Cloud edit: diff against the current trip and only send changed fields —
  // a save with no changes (or only one field changed) should not re-write
  // every column. If nothing changed, skip the mutation entirely.
  const saveTrip = isDemo ? demoSelection.saveTrip : (data: TripItem) => {
    if (!currentTrip || data.id !== currentTrip.id) return
    const updates: Partial<CreateTripInput> = {}
    if (data.title !== currentTrip.title)       updates.title       = data.title
    if (data.dest  !== currentTrip.destination) updates.destination = data.dest
    if (data.emoji !== (currentTrip.icon ?? '✈️')) updates.icon     = data.emoji
    if (data.startDate !== toLocalDateString(currentTrip.startDate.toDate()))
      updates.startDate = data.startDate
    if (data.endDate !== toLocalDateString(currentTrip.endDate.toDate()))
      updates.endDate = data.endDate
    setActiveDate(null)
    if (Object.keys(updates).length === 0) return
    updateTripMut.mutate({ tripId: data.id, updates })
  }

  // Cloud delete: if removing the active trip, swap to the next surviving
  // one (or null) BEFORE firing the mutation — that way the UI never renders
  // against a trip whose schedules/members are vanishing under it. On
  // mutation failure we restore the previous selection so the user isn't
  // left on a different trip than the cache shows.
  const deleteTrip = isDemo ? demoSelection.deleteTrip : (deletedId: string) => {
    const wasCurrent = currentTrip?.id === deletedId
    const restore    = currentTrip
    if (wasCurrent) {
      const remaining = (myTrips ?? []).filter(t => t.id !== deletedId)
      setCurrentTrip(remaining[0] ?? null)
      setActiveDate(null)
    }
    deleteTripMut.mutate(deletedId, {
      onSuccess: () => toast.success('旅程を削除しました'),
      onError:   () => { if (wasCurrent && restore) setCurrentTrip(restore) },
    })
  }

  const reorderTrips = isDemo ? demoSelection.reorderTrips : () => {}

  // Cloud mode: distinguish "loading" (undefined + no error) from "empty"
  // (length === 0) from "error" (query threw). Previous version collapsed
  // error into loading, which hid Firestore permission/index issues behind
  // a silent infinite spinner.
  if (!isDemo) {
    if (tripsError && myTrips === undefined) {
      return (
        <div className="flex flex-col items-center justify-center h-full px-6 text-center gap-3">
          <div className="text-[40px] leading-none">⚠️</div>
          <div className="text-[13px] text-ink leading-[1.6]">読み込みに失敗しました</div>
          <div className="text-[11px] text-muted leading-[1.6] max-w-[320px] break-words">
            {tripsError.message}
          </div>
          <button
            onClick={() => refetchTrips()}
            className="mt-2 h-10 px-5 rounded-chip border border-border bg-surface text-ink text-[12.5px] font-semibold cursor-pointer hover:bg-tile transition-colors"
          >
            再読み込み
          </button>
        </div>
      )
    }
    if (myTrips === undefined) {
      return (
        <div className="flex items-center justify-center h-full text-muted text-[13px]">
          <LoadingText />
        </div>
      )
    }
    if (myTrips.length === 0) {
      return (
        <>
          <EmptyTrips onCreate={() => setCreateTripOpen(true)} />
          <CreateTripModal isOpen={createTripOpen} onClose={() => setCreateTripOpen(false)} />
        </>
      )
    }
  }

  // Between auth resolution and the sync-useEffect picking a currentTrip,
  // selectedTrip can briefly be null in cloud mode. Render a spinner instead
  // of nothing.
  if (!selectedTrip) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-[13px]">
        <LoadingText />
      </div>
    )
  }

  const dateRange = buildDateRange(selectedTrip.startDate, selectedTrip.endDate)
  const grouped   = groupByDate(schedules)
  const display   = (activeDate && dateRange.includes(activeDate)) ? activeDate : dateRange[0]
  const items     = display ? (grouped[display] ?? []) : []
  const dayTotal  = items.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)
  const tripTotal = schedules.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)

  function handleMenuAction(key: MenuActionKey) {
    if (key === 'edit') { setEditTripOpen(true); return }
    // 'members' opens the roster/admin sheet (list + remove). 'share' opens
    // the invite-link sheet. They used to share one modal; separating them
    // matches the menu copy ("管理成員" vs "分享行程") and keeps each sheet
    // focused on a single responsibility. Demo mode has no real tripId →
    // sign-in prompt.
    if (key === 'members') {
      if (isDemo) { setSignInOpen(true); return }
      setMembersOpen(true)
      return
    }
    if (key === 'share') {
      if (isDemo) { setSignInOpen(true); return }
      setInviteOpen(true)
      return
    }
    toast.info(`${key} は開発中です`)
  }

  function openAdd()             { setEditTarget(null); setModalOpen(true) }
  function openEdit(s: Schedule) { setEditTarget(s);    setModalOpen(true) }
  function closeModal()          { setModalOpen(false); setEditTarget(null) }

  // Demo save → close form, pop sign-in prompt. Cloud save → Firestore write
  // with optimistic updates (hook surfaces toast on failure).
  async function handleSave(data: CreateScheduleInput) {
    if (isDemo) { setModalOpen(false); setSignInOpen(true); return }
    if (!editTarget && !uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    try {
      if (editTarget) {
        await updateMut.mutateAsync({ scheduleId: editTarget.id, updates: data })
      } else {
        await createMut.mutateAsync({ input: data, userId: uid! })
      }
      closeModal()
    } catch { /* hook onError already surfaced the toast */ }
  }
  async function handleDelete() {
    if (!editTarget) { closeModal(); return }
    if (isDemo) { setModalOpen(false); setSignInOpen(true); return }
    try {
      await deleteMut.mutateAsync(editTarget.id)
      closeModal()
    } catch { /* hook onError already surfaced the toast */ }
  }

  return (
    <div className="bg-app min-h-full pb-8">

      {/* ── DEMO BANNER ────────────────────────────────────── */}
      {isDemo && (
        <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-accent-pale border border-accent/15 flex items-center gap-2">
          <div className="flex-1 min-w-0 text-[10.5px] text-accent leading-[1.5] tracking-[0.02em]">
            <span className="font-bold">プレビューモード</span>
            <span className="opacity-75"> · サインインで自分の旅程を保存</span>
          </div>
          <button
            onClick={() => setSignInOpen(true)}
            className="shrink-0 h-7 px-3 rounded-full bg-accent text-white text-[10.5px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.97]"
            style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
          >
            サインイン
          </button>
        </div>
      )}

      {/* ── HEADER ─────────────────────────────────────────── */}
      <div className="px-4 pt-3.5 pb-3 bg-app">
        <TripSwitcher
          trips={trips}
          selected={selectedTrip}
          onSelect={selectTrip}
          onAction={handleMenuAction}
          onDelete={deleteTrip}
          onReorder={reorderTrips}
          onCreateTrip={() => setCreateTripOpen(true)}
          canDeleteLast={!isDemo}
        />
      </div>

      {/* ── TRIP CARD ──────────────────────────────────────── */}
      <TripHeaderCard
        selectedTrip={selectedTrip}
        tripDays={dateRange.length}
        scheduleCount={schedules.length}
        tripTotal={tripTotal}
        onEditTrip={() => setEditTripOpen(true)}
        onInvite={() => isDemo ? setSignInOpen(true) : setInviteOpen(true)}
      />

      {/* ── DAY SELECTOR ───────────────────────────────────── */}
      <div className="mt-5">
        <div className="px-5 pb-0.5 flex items-center justify-between">
          <span className="text-[11px] font-bold text-muted tracking-[0.1em] uppercase">
            日程選択
          </span>
          <span className="text-[11px] text-muted">{dateRange.length} 日間</span>
        </div>

        <div className="flex gap-2 px-5 pt-2.5 pb-1 overflow-x-auto overflow-y-visible no-scrollbar">
          {dateRange.map((date, i) => {
            const active    = date === display
            const d         = fromLocalDateString(date)
            const dayItems  = grouped[date] ?? []
            const hasItems  = dayItems.length > 0
            return (
              <button
                key={date}
                onClick={() => setActiveDate(date)}
                aria-current={active ? 'date' : undefined}
                aria-label={`Day${i+1} ${date}${hasItems ? `（${dayItems.length}件）` : ''}`}
                className={[
                  'shrink-0 relative flex flex-col items-center px-3 pt-2.5 pb-2 rounded-2xl cursor-pointer transition-all min-w-[52px] gap-0.5',
                  active
                    ? 'border-0 bg-accent text-white'
                    : `border border-border bg-surface ${hasItems ? 'text-ink' : 'text-muted'}`,
                  hasItems || active ? 'opacity-100' : 'opacity-65',
                ].join(' ')}
              >
                <span className="text-[8px] font-bold tracking-[0.08em] opacity-80 uppercase">
                  Day{i+1}
                </span>
                <span className="text-[20px] font-black leading-none">
                  {d.getDate()}
                </span>
                <span className="text-[8.5px] opacity-70">
                  {d.toLocaleDateString('zh-TW', { weekday:'short' })}
                </span>
                {hasItems ? (
                  <div
                    className={[
                      'absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-[5px] rounded-[9px] text-[10px] font-extrabold tracking-[0.02em] flex items-center justify-center border-2 border-app shadow-[0_2px_6px_rgba(0,0,0,0.12)] pointer-events-none',
                      active ? 'bg-white text-accent' : 'bg-teal text-white',
                    ].join(' ')}
                  >
                    {dayItems.length}
                  </div>
                ) : !active && (
                  <div className="absolute -top-[3px] -right-[3px] w-2 h-2 rounded-full bg-dot border-2 border-app pointer-events-none" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── DAY TIMELINE ───────────────────────────────────── */}
      <div className="mx-5 mt-5">
        {display && (
          <div className="flex justify-between items-center mb-3.5">
            <div>
              <span className="text-[15px] font-bold text-ink">
                {new Date(display).toLocaleDateString('zh-TW', { month:'long', day:'numeric' })}
              </span>
              <span className="text-[12px] text-muted ml-1.5">
                {new Date(display).toLocaleDateString('zh-TW', { weekday:'long' })}
              </span>
            </div>
            {dayTotal > 0 && (
              <div className="bg-[#F2EAE0] text-[#906848] text-[11px] font-semibold px-2.5 py-1 rounded-card">
                合計 ¥{dayTotal.toLocaleString()}
              </div>
            )}
          </div>
        )}

        {isLoading && !isDemo ? (
          <div className="text-center py-12 text-dot text-[13px]">
            <LoadingText />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
            <div className="text-[40px] mb-1.5 opacity-55">🗓</div>
            <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
              この日の予定はまだありません
            </p>
            <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
              さあ、最初の行程を追加しましょう
            </p>
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              行程を追加
            </button>
          </div>
        ) : (
          <>
            {items.map((s, idx) => (
              <TimelineCard
                key={s.id}
                s={s}
                isLast={idx === items.length - 1}
                onEdit={() => openEdit(s)}
              />
            ))}

            <div className="flex mt-2.5">
              <div className="w-12 shrink-0" />
              <button
                onClick={openAdd}
                className="flex-1 h-11 rounded-chip border-[1.5px] border-dashed border-border bg-transparent text-muted text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
              >
                <Plus size={14} strokeWidth={2} />
                行程を追加
              </button>
            </div>
          </>
        )}
      </div>

      {/* Conditionally render + keyed for fresh state per open (see the
          parallel note in ExpensePage). */}
      {modalOpen && (
        <ScheduleFormModal
          key={editTarget?.id ?? 'new'}
          isOpen
          editTarget={editTarget}
          defaultDate={display ?? new Date().toISOString().slice(0,10)}
          isSaving={isSaving}
          onClose={closeModal}
          onSave={handleSave}
          onDelete={editTarget ? handleDelete : undefined}
        />
      )}

      {/* Conditionally render + keyed so every open initializes from the
          current trip via useState (no sync-in-effect; no stale state
          after a cancel-then-reopen). */}
      {editTripOpen && (
        <EditTripModal
          key={selectedTrip.id}
          isOpen
          editTarget={selectedTrip}
          scheduleDates={schedules.map(s => s.date)}
          onClose={() => setEditTripOpen(false)}
          onSave={data => { saveTrip(data); setEditTripOpen(false) }}
        />
      )}

      <CreateTripModal
        isOpen={createTripOpen}
        onClose={() => setCreateTripOpen(false)}
      />

      {!isDemo && currentTrip && (
        <>
          <InviteModal
            isOpen={inviteOpen}
            onClose={() => setInviteOpen(false)}
            trip={currentTrip}
          />
          <MembersModal
            isOpen={membersOpen}
            onClose={() => setMembersOpen(false)}
            trip={currentTrip}
          />
        </>
      )}

      <SignInPromptModal
        isOpen={signInOpen}
        onClose={() => setSignInOpen(false)}
        reason="行程を保存するには、"
      />
    </div>
  )
}

function EmptyTrips({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-app min-h-full flex flex-col items-center justify-center px-6 py-10">
      <div className="text-[52px] leading-none mb-4">🗺️</div>
      <h2 className="m-0 mb-1.5 text-[20px] font-black text-ink -tracking-[0.3px]">
        最初の旅を始めましょう
      </h2>
      <p className="m-0 mb-7 text-[12.5px] text-muted text-center max-w-[280px] leading-[1.7] tracking-[0.02em]">
        行程・費用・日記を一つのアプリで。<br />
        まずは旅程を作成してください。
      </p>
      <button
        onClick={onCreate}
        className="inline-flex items-center gap-1.5 px-6 py-3 rounded-chip border-none bg-teal text-white text-[13.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
        style={{ boxShadow: '0 6px 20px rgba(61,139,122,0.28)' }}
      >
        <Plus size={15} strokeWidth={2.5} />
        新しい旅を作成
      </button>
    </div>
  )
}
