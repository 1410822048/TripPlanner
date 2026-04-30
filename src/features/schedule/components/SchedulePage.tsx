// src/features/schedule/components/SchedulePage.tsx
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule } from '../hooks/useSchedules'
import { useDeleteTrip, useMyTrips, useUpdateTrip } from '@/features/trips/hooks/useTrips'
import { useTripSelection } from '@/features/trips/hooks/useTripSelection'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useTripStore } from '@/store/tripStore'
import { useUid } from '@/hooks/useAuth'
import type { CreateScheduleInput, CreateTripInput, Schedule, Trip } from '@/types'
import type { MenuActionKey, TripItem } from '@/features/trips/types'
import { MOCK_SCHEDULES } from '../mocks'
import { buildDateRange, groupByDate } from '../utils'
import { toLocalDateString } from '@/utils/dates'
import { toast } from '@/shared/toast'
import ScheduleFormModal from './ScheduleFormModal'
import EditTripModal from '@/features/trips/components/EditTripModal'
import TripSwitcher from '@/features/trips/components/TripSwitcher'
import TripHeaderCard from '@/features/trips/components/TripHeaderCard'
import DaySelector from './DaySelector'
import DayTimeline from './DayTimeline'
import CreateTripModal from '@/features/trips/components/CreateTripModal'
// Lazy-loaded: InviteModal pulls in qrcode.react (~30 KB raw / ~10 KB gzip)
// for the share-link QR code, which has no business being on the
// initial-render critical path. The chunk loads when the user opens
// "share trip" — by which point the page has long settled, so the
// brief Suspense fallback (<50ms typical) is invisible.
const InviteModal = lazy(() => import('@/features/trips/invites/InviteModal'))
import MembersModal from '@/features/members/components/MembersModal'
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

  const { currentTrip, setCurrentTrip } = useTripStore()
  const { data: myTrips, error: tripsError, refetch: refetchTrips } = useMyTrips(uid)

  const [activeDate,     setActiveDate]     = useState<string | null>(null)
  const [modalOpen,      setModalOpen]      = useState(false)
  const [editTarget,     setEditTarget]     = useState<Schedule | null>(null)
  const [editTripOpen,   setEditTripOpen]   = useState(false)
  const [createTripOpen, setCreateTripOpen] = useState(false)

  // AccountPage's "Planner" card navigates here with state.openCreateTrip = true
  // to deep-link straight into the create-trip flow. We consume the flag once,
  // open the modal, and clear the state via replace so a refresh / back-button
  // doesn't re-trigger.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const s = location.state as { openCreateTrip?: boolean } | null
    if (!s?.openCreateTrip) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreateTripOpen(true)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])
  const [signInOpen,     setSignInOpen]     = useState(false)
  const [inviteOpen,     setInviteOpen]     = useState(false)
  const [membersOpen,    setMembersOpen]    = useState(false)

  const demoSelection = useTripSelection(() => setActiveDate(null))

  // Trip ↔ Zustand sync now lives in AppLayout via useCurrentTripSync, so
  // /bookings / /expense after hard reload doesn't get stuck on "select a
  // trip". This page just reads the resulting `currentTrip`.

  // ─── Mode-specific state ───────────────────────────────────────
  // Both memos have to exist before the downstream `selectedTrip` /
  // `trips` memos — without them, every render creates a new TripItem
  // object (and a new TripItem[] from .map), which would invalidate the
  // child memos that depend on identity.
  const cloudTripItem = useMemo(
    () => !isDemo && currentTrip ? cloudTripToItem(currentTrip) : null,
    [isDemo, currentTrip],
  )
  const cloudTripsList = useMemo<TripItem[]>(
    () => !isDemo ? (myTrips ?? []).map(cloudTripToItem) : [],
    [isDemo, myTrips],
  )

  const tripId = isDemo ? demoSelection.selectedTrip.id : currentTrip?.id
  const { data: fbSchedules, isLoading } = useSchedules(isDemo ? undefined : tripId)
  const { data: fbMembers } = useMembers(isDemo ? undefined : tripId)
  const memberChips = useMemo(() => membersToTripMembers(fbMembers ?? []), [fbMembers])

  // useMemo so an empty-state render doesn't produce a fresh [] each
  // pass — without this, the downstream `grouped` / `tripTotal` memos
  // would invalidate on every parent re-render.
  const schedules = useMemo(
    () => isDemo
      ? (demoSelection.selectedTrip.id === 'demo' ? MOCK_SCHEDULES : [])
      : (fbSchedules ?? []),
    [isDemo, demoSelection.selectedTrip.id, fbSchedules],
  )

  // Memoise the per-day bucket and the trip-wide total — the original
  // inline reductions ran on every parent state change (modal toggle,
  // day select, trip switcher open, etc).
  const grouped   = useMemo(() => groupByDate(schedules), [schedules])
  const tripTotal = useMemo(
    () => schedules.reduce((s, i) => s + (i.estimatedCost ?? 0), 0),
    [schedules],
  )

  const trips = isDemo ? demoSelection.trips : cloudTripsList
  // Memoised so `TripHeaderCard` (memo'd on selectedTrip identity) and any
  // future child that compares trip references can actually skip re-renders.
  // Without this, the spread `{ ...cloudTripItem, members: memberChips }`
  // produced a fresh object every render and defeated the child memo.
  const selectedTrip = useMemo(() => {
    if (isDemo) return demoSelection.selectedTrip
    return cloudTripItem ? { ...cloudTripItem, members: memberChips } : null
  }, [isDemo, demoSelection.selectedTrip, cloudTripItem, memberChips])

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

  // Between auth resolution and AppLayout's useCurrentTripSync picking a
  // currentTrip, selectedTrip can briefly be null in cloud mode. Render a
  // spinner instead of nothing.
  if (!selectedTrip) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-[13px]">
        <LoadingText />
      </div>
    )
  }

  const dateRange = buildDateRange(selectedTrip.startDate, selectedTrip.endDate)
  const display   = (activeDate && dateRange.includes(activeDate)) ? activeDate : dateRange[0]
  const items     = display ? (grouped[display] ?? []) : []
  // dayTotal stays inline — items per day are small (≤ 20 typical) and
  // depend on selectedTrip which is null inside the early-return cases,
  // so hoisting it costs more than it saves.
  const dayTotal  = items.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)

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

      <DaySelector
        dateRange={dateRange}
        display={display}
        grouped={grouped}
        onSelectDay={setActiveDate}
      />

      <DayTimeline
        display={display}
        items={items}
        dayTotal={dayTotal}
        isLoading={isLoading && !isDemo}
        onAdd={openAdd}
        onEdit={openEdit}
      />

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
          {/* `null` Suspense fallback so the lazy-loaded modal chunk
              loads in the background without flashing the page-level
              fallback from AppLayout. Modal pops up when chunk arrives;
              after first open the chunk is cached so subsequent opens
              are instant. */}
          <Suspense fallback={null}>
            <InviteModal
              isOpen={inviteOpen}
              onClose={() => setInviteOpen(false)}
              trip={currentTrip}
            />
          </Suspense>
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
