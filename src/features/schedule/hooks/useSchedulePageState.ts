// src/features/schedule/hooks/useSchedulePageState.ts
// All non-rendering state + derived values + action callbacks for
// SchedulePage. Extracting this lets the page component itself read as
// pure layout orchestration: pick a few values from the returned bag,
// hand modals off to TripModalsHost, render.
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useFormModal, type UseFormModalResult } from '@/hooks/useFormModal'
import { useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule } from './useSchedules'
import { useCopyTrip, useDeleteTrip, useLeaveTrip, useMyTrips, useUpdateTrip } from '@/features/trips/hooks/useTrips'
import { useCurrentTrip } from '@/features/trips/hooks/useCurrentTrip'
import type { CopyTripInput } from '@/features/trips/services/tripCopy'
import { useTripSelection } from '@/features/trips/hooks/useTripSelection'
import { useCanWrite, useIsTripOwner } from '@/features/trips/hooks/useTripRole'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useTripStore } from '@/store/tripStore'
import { useAuth } from '@/hooks/useAuth'
import type { CreateScheduleInput, CreateTripInput, Schedule, Trip } from '@/types'
import type { MenuActionKey, TripItem } from '@/features/trips/types'
import { MOCK_SCHEDULES } from '../mocks'
import { buildDateRange, groupByDate } from '../utils'
import { toLocalDateString } from '@/utils/dates'
import { toast } from '@/shared/toast'
import { simulateFailureMaybe } from '@/utils/devFailures'

// Adapter: Firestore Trip → presentation TripItem. `icon` is persisted on
// the Trip doc (default ✈️ for trips created before the field existed).
// Member chips come from useMembers separately. `uid` is needed to
// compute `ownedByMe` so TripSwitcher can gate per-trip delete swipe /
// button on trip ownership (mirrors firestore.rules `isTripOwner`).
function cloudTripToItem(trip: Trip, uid: string | undefined): TripItem {
  return {
    id:        trip.id,
    title:     trip.title,
    dest:      trip.destination,
    emoji:     trip.icon ?? '✈️',
    startDate: toLocalDateString(trip.startDate.toDate()),
    endDate:   toLocalDateString(trip.endDate.toDate()),
    members:   [],
    ownedByMe: !!uid && trip.ownerId === uid,
    currency:  trip.currency,
  }
}

export interface SchedulePageState {
  // ─── Mode & guards ────────────────────────────────────────────
  isDemo:   boolean
  canWrite: boolean
  isOwner:  boolean

  // ─── Cloud query state for early returns ──────────────────────
  cloudTripsLoading: boolean
  cloudTripsError:   Error | null
  cloudTripsEmpty:   boolean
  refetchTrips:      () => void

  // ─── Display data ─────────────────────────────────────────────
  trips:        TripItem[]
  selectedTrip: TripItem | null
  dateRange:    string[]
  display:      string | undefined
  items:        Schedule[]
  dayTotal:     number
  schedules:    Schedule[]
  tripTotal:    number
  grouped:      Record<string, Schedule[]>
  isLoading:    boolean

  // ─── Trip switcher actions ────────────────────────────────────
  selectTrip:       (item: TripItem) => void
  saveTrip:         (data: TripItem) => void
  deleteTrip:       (deletedId: string) => void
  /** Non-owner self-leave of the current trip (MembersModal footer). */
  onLeaveTrip:      () => void
  reorderTrips:     (fromIdx: number, toIdx: number) => void
  handleMenuAction: (key: MenuActionKey) => void

  // ─── Day timeline actions ─────────────────────────────────────
  setActiveDate: (date: string | null) => void

  // ─── Modal state ──────────────────────────────────────────────
  // Shared modal-state primitive (matches the other 4 feature pages).
  // Consumers read scheduleModal.isOpen / editTarget / saveError, and
  // call openAdd / openEdit / close / setError / clearError on it.
  // The page-specific save + delete handlers stay on the bag.
  scheduleModal:    UseFormModalResult<Schedule>
  scheduleDetailTarget: Schedule | null
  openScheduleDetail:   (schedule: Schedule) => void
  closeScheduleDetail:  () => void
  editScheduleFromDetail: () => void
  scheduleIsSaving: boolean
  onScheduleSave:   (data: CreateScheduleInput) => Promise<void>
  onScheduleDelete: () => Promise<void>

  editTripOpen:    boolean
  setEditTripOpen: (open: boolean) => void

  createTripOpen:    boolean
  setCreateTripOpen: (open: boolean) => void

  copyTripOpen:    boolean
  setCopyTripOpen: (open: boolean) => void
  /** Snapshot of the trip taken when the copy modal opens. TripModalsHost
   *  renders CopyTripModal off this (not `currentTrip`) so post-mutation
   *  trip switches don't re-key the modal during its close transition. */
  copyTripSource:  Trip | null
  copyTripPending: boolean
  onCopyTrip:      (input: CopyTripInput) => Promise<void>

  inviteOpen:    boolean
  setInviteOpen: (open: boolean) => void

  membersOpen:    boolean
  setMembersOpen: (open: boolean) => void

  signInOpen:    boolean
  setSignInOpen: (open: boolean) => void

  // ─── Pass-through references ──────────────────────────────────
  // TripModalsHost needs these to wire CopyTripModal / InviteModal /
  // MembersModal which speak `Trip` (not `TripItem`).
  currentTrip: Trip | null
}

export function useSchedulePageState(): SchedulePageState {
  // Auth drives the mode split. copyTrip needs displayName + photoURL
  // → owner member doc, so we pull the full auth state. uid is derived
  // from it; no separate useUid() subscription needed.
  //
  // Preview-first UX: the page can paint demo content during the
  // initial auth-resolution window (Firebase IndexedDB token read is
  // async) — BUT only when the user is genuinely new. For returning
  // users we wait for the signed-in state to land instead of flashing
  // demo. The `wasSignedIn` flag on `authState.status === 'loading'`
  // is a synchronous localStorage hint set by useAuth's observer;
  // it tells us which sub-case we're in.
  // Hint-gated by default — see useAuth's docstring. Never-signed-in
  // visitors never trigger the Auth SDK fetch here; the `wasSignedIn`
  // hint on the loading state gives SchedulePage the synchronous
  // demo/cloud signal it needs without loading the observer.
  const { state: authState } = useAuth()
  const uid           = authState.status === 'signed-in' ? authState.user.uid : undefined
  const authResolving = authState.status === 'loading'
  const wasSignedIn   = authState.status === 'loading' && authState.wasSignedIn
  const isDemo        = !uid && !wasSignedIn

  const currentTrip       = useCurrentTrip()
  const setSelectedTripId = useTripStore(s => s.setSelectedTripId)
  const tripOrder         = useTripStore(s => s.tripOrder)
  const setTripOrder   = useTripStore(s => s.setTripOrder)

  const { data: myTrips, error: tripsError, refetch: refetchTrips } = useMyTrips(uid)

  const [activeDate,     setActiveDate]     = useState<string | null>(null)
  // Shared modal-state primitive — matches the 4 other feature pages
  // (Booking/Expense/Planning/Wish). Exposes editTarget + saveError +
  // openAdd/openEdit/close, so the page-level fields below are thin
  // adapters preserving SchedulePageState's existing public shape.
  const scheduleModal = useFormModal<Schedule>()
  const [scheduleDetailId, setScheduleDetailId] = useState<string | null>(null)
  const [editTripOpen,   setEditTripOpen]   = useState(false)
  const [createTripOpen, setCreateTripOpen] = useState(false)
  const [copyTripOpen,   setCopyTripOpen]   = useState(false)
  // Snapshot of `currentTrip` taken when the copy modal opens. Decouples
  // the modal's identity (key + source) from currentTrip so the post-
  // mutation `setSelectedTripId(newTrip.id)` doesn't re-key the modal
  // mid-close — that re-key was causing a 3-frame flash
  // (close→open→close) because the modal's key changed from sourceId
  // to newTripId in the same render where copyTripOpen was still true.
  // The snapshot stays put until the next open.
  const [copyTripSource, setCopyTripSource] = useState<Trip | null>(null)
  const [signInOpen,     setSignInOpen]     = useState(false)
  const [inviteOpen,     setInviteOpen]     = useState(false)
  const [membersOpen,    setMembersOpen]    = useState(false)

  // AccountPage's "Planner" card navigates here with state.openCreateTrip
  // = true to deep-link straight into the create-trip flow. Consume the
  // flag once, open the modal, and clear via replace so refresh /
  // back-button doesn't re-trigger.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const s = location.state as { openCreateTrip?: boolean } | null
    if (!s?.openCreateTrip) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCreateTripOpen(true)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

  const demoSelection = useTripSelection(() => setActiveDate(null))

  // Compiler memoises both `cloudTripItem` and `cloudTripsList` based
  // on inferred deps. Apply user's saved order from drag-to-reorder.
  // Trips not in the saved list (newly joined / created since last
  // reorder) bubble to the top so they remain discoverable.
  const cloudTripItem: TripItem | null =
    !isDemo && currentTrip ? cloudTripToItem(currentTrip, uid) : null

  const cloudTripsList: TripItem[] = isDemo
    ? []
    : (() => {
        const items = (myTrips ?? []).map(t => cloudTripToItem(t, uid))
        if (tripOrder.length === 0) return items
        const orderIdx = new Map(tripOrder.map((id, i) => [id, i]))
        return [...items].sort((a, b) => {
          const ai = orderIdx.get(a.id)
          const bi = orderIdx.get(b.id)
          if (ai === undefined && bi === undefined) return 0
          if (ai === undefined) return -1
          if (bi === undefined) return 1
          return ai - bi
        })
      })()

  const tripId = isDemo ? demoSelection.selectedTrip.id : currentTrip?.id
  const { data: fbSchedules, isLoading } = useSchedules(isDemo ? undefined : tripId)
  const { data: fbMembers } = useMembers(isDemo ? undefined : tripId)
  // Viewers can read schedules but not create/edit/delete — mirrors the
  // canWrite gate in firestore.rules. Hide the affordances they can't
  // actually use (add buttons in DayTimeline, delete in the form modal).
  const canWrite = useCanWrite(isDemo ? undefined : tripId, isDemo)
  const isOwner  = useIsTripOwner(isDemo ? undefined : tripId, isDemo)
  const memberChips = membersToTripMembers(fbMembers ?? [])

  // Compiler memoises these derivations. The per-day bucket + trip-wide
  // total used to be inline reductions running on every parent state
  // change (modal toggle, day select, trip switcher open, etc); now the
  // compiler caches them based on `schedules` identity.
  const schedules = isDemo
    ? (demoSelection.selectedTrip.id === 'demo' ? MOCK_SCHEDULES : [])
    : (fbSchedules ?? [])

  const grouped   = groupByDate(schedules)
  const tripTotal = schedules.reduce((s, i) => s + (i.estimatedCostMinor ?? 0), 0)
  const scheduleDetailTarget = scheduleDetailId
    ? schedules.find(schedule => schedule.id === scheduleDetailId) ?? null
    : null

  const trips = isDemo ? demoSelection.trips : cloudTripsList
  // Compiler memoises `selectedTrip` — child components (TripHeaderCard
  // etc.) get a stable reference when nothing relevant changed.
  const selectedTrip = isDemo
    ? demoSelection.selectedTrip
    : cloudTripItem ? { ...cloudTripItem, members: memberChips } : null

  // silent — modal surfaces errors via inline banner(scheduleSaveError),
  // global toast would double-notify.
  const createMut     = useCreateSchedule(tripId ?? '', { silent: true })
  const updateMut     = useUpdateSchedule(tripId ?? '', { silent: true })
  const deleteMut     = useDeleteSchedule(tripId ?? '')
  const updateTripMut = useUpdateTrip(uid)
  const deleteTripMut = useDeleteTrip(uid)
  const leaveTripMut  = useLeaveTrip(uid)
  const copyTripMut   = useCopyTrip()
  const isSaving      = createMut.isPending || updateMut.isPending

  // ─── Derived display state ────────────────────────────────────
  const dateRange = selectedTrip
    ? buildDateRange(selectedTrip.startDate, selectedTrip.endDate)
    : []
  const display = (activeDate && dateRange.includes(activeDate)) ? activeDate : dateRange[0]
  const items   = display ? (grouped[display] ?? []) : []
  // dayTotal stays inline — items per day are small (≤ 20 typical) so
  // hoisting it costs more than it saves.
  const dayTotal = items.reduce((s, i) => s + (i.estimatedCostMinor ?? 0), 0)

  // ─── Action callbacks ─────────────────────────────────────────
  const selectTrip = (item: TripItem) => {
    setScheduleDetailId(null)
    if (isDemo) {
      demoSelection.selectTrip(item)
      return
    }
    // myTrips lookup retained as a "trip exists" gate — picking
    // an id the user no longer has access to would just produce
    // a null useCurrentTrip downstream and a confused UI.
    if (myTrips?.some(t => t.id === item.id)) {
      setSelectedTripId(item.id)
      setActiveDate(null)
    }
  }

  // Cloud edit: diff against the current trip and only send changed
  // fields — a save with no changes (or only one field changed) should
  // not re-write every column. If nothing changed, skip entirely.
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
    if (data.currency !== currentTrip.currency) updates.currency = data.currency
    setActiveDate(null)
    if (Object.keys(updates).length === 0) return
    updateTripMut.mutate({ tripId: data.id, updates })
  }

  // Cloud delete: if removing the active trip, swap to the next surviving
  // one (or null) BEFORE firing the mutation — that way the UI never
  // renders against a trip whose schedules/members are vanishing under
  // it. On mutation failure we restore the previous selection so the
  // user isn't left on a different trip than the cache shows.
  const deleteTrip = isDemo ? demoSelection.deleteTrip : (deletedId: string) => {
    const wasCurrent = currentTrip?.id === deletedId
    const restoreId  = currentTrip?.id
    if (wasCurrent) {
      const remaining = (myTrips ?? []).filter(t => t.id !== deletedId)
      setSelectedTripId(remaining[0]?.id ?? null)
      setActiveDate(null)
    }
    deleteTripMut.mutate(deletedId, {
      onSuccess: () => toast.success('旅程を削除しました'),
      onError:   () => { if (wasCurrent && restoreId) setSelectedTripId(restoreId) },
    })
  }

  // Cloud-only: a non-owner leaves the current trip (MembersModal footer).
  // Mirrors deleteTrip's "switch to the next surviving trip BEFORE the
  // mutation" so the UI never renders against a trip vanishing under it.
  // The modal is closed first — after the switch, currentTrip becomes a
  // different trip (or null), and leaving the modal open would show the
  // wrong trip's members. On failure we restore the selection (the user
  // is still a member); the optimistic cache rollback + onSettled
  // invalidate in useLeaveTrip re-sync the trip list.
  function onLeaveTrip() {
    const tripId = currentTrip?.id
    if (!tripId) return
    setMembersOpen(false)
    const remaining = (myTrips ?? []).filter(t => t.id !== tripId)
    setSelectedTripId(remaining[0]?.id ?? null)
    setActiveDate(null)
    leaveTripMut.mutate(tripId, {
      onSuccess: () => toast.success('旅程から退出しました'),
      onError:   () => setSelectedTripId(tripId),
    })
  }

  // Cloud reorder: persist a per-user trip-id order in the zustand
  // store (localStorage-backed). The `cloudTripsList` memo above
  // applies this order on render, so the splice + setTripOrder is
  // sufficient — no Firestore write involved (ordering is a personal
  // view preference, not shared trip metadata).
  const reorderTrips = isDemo ? demoSelection.reorderTrips : (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return
    const ids = cloudTripsList.map(t => t.id)
    const [moved] = ids.splice(fromIdx, 1)
    if (!moved) return
    ids.splice(toIdx, 0, moved)
    setTripOrder(ids)
  }

  // Demo mode lacks a real tripId, so every cloud-only action funnels
  // through the sign-in prompt before mutating state.
  function handleMenuAction(key: MenuActionKey) {
    switch (key) {
      case 'edit':
        setEditTripOpen(true)
        return
      case 'members':
        if (isDemo) setSignInOpen(true)
        else        setMembersOpen(true)
        return
      case 'share':
        if (isDemo) setSignInOpen(true)
        else        setInviteOpen(true)
        return
      case 'copy':
        if (isDemo) {
          setSignInOpen(true)
        } else if (currentTrip) {
          // Snapshot the source NOW — modal's key + source props read
          // from this snapshot so the post-mutation trip switch doesn't
          // re-key the modal mid-close.
          setCopyTripSource(currentTrip)
          setCopyTripOpen(true)
        }
        return
      default: {
        // Exhaustiveness check: if MenuActionKey gains a member, TS will
        // flag this assignment until the new case is handled.
        const _exhaustive: never = key
        toast.info(`${_exhaustive} は開発中です`)
      }
    }
  }

  // Cloud-only — gate is in handleMenuAction. uid is guaranteed at this
  // point (signed-in branch) but we read auth state defensively for the
  // createTrip payload (ownerId, displayName).
  async function onCopyTrip(input: CopyTripInput) {
    // Read from the snapshot, not currentTrip — by the time this fires
    // the user is mid-confirm and currentTrip could theoretically
    // change under us (rare but possible). The snapshot is what the
    // modal is showing, so use the same value for the mutation.
    if (!copyTripSource || !uid || authState.status !== 'signed-in') return
    try {
      const { trip, copiedSchedules, copiedPlanItems, orphanedSchedules } =
        await copyTripMut.mutateAsync({ source: copyTripSource, input, user: authState.user })
      // Modal close commits cleanly because its render gate
      // (copyTripSource + copyTripOpen) doesn't depend on currentTrip.
      // setSelectedTripId can flip currentTrip = newTrip in the same
      // commit; modal doesn't see it.
      setSelectedTripId(trip.id)
      setActiveDate(null)
      setCopyTripOpen(false)
      const parts = [`「${trip.title}」を作成`]
      if (input.copySchedules) parts.push(`行程 ${copiedSchedules} 件`)
      if (input.copyPlanning)  parts.push(`計畫 ${copiedPlanItems} 件`)
      toast.success(parts.join(' · '))
      if (orphanedSchedules > 0) {
        toast.info(`${orphanedSchedules} 件の行程が新しい日付範圍外`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? `複製に失敗：${e.message}` : '複製に失敗しました')
    }
  }

  // Demo save → close form, pop sign-in prompt. Cloud save → Firestore
  // write with optimistic updates (hook surfaces toast on failure).
  async function onScheduleSave(data: CreateScheduleInput) {
    if (isDemo) { scheduleModal.close(); setSignInOpen(true); return }
    if (!uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    scheduleModal.clearError()
    try {
      await simulateFailureMaybe()
      if (scheduleModal.editTarget) {
        await updateMut.mutateAsync({ scheduleId: scheduleModal.editTarget.id, updates: data, uid })
      } else {
        await createMut.mutateAsync({ input: data, createdBy: uid })
      }
      scheduleModal.close()
    } catch (err) {
      scheduleModal.setError(err instanceof Error ? err.message : '保存に失敗しました')
    }
  }
  async function onScheduleDelete() {
    if (!scheduleModal.editTarget) { scheduleModal.close(); return }
    if (isDemo) { scheduleModal.close(); setSignInOpen(true); return }
    try {
      await deleteMut.mutateAsync(scheduleModal.editTarget.id)
      scheduleModal.close()
    } catch { /* hook onError already surfaced the toast */ }
  }

  function openScheduleDetail(schedule: Schedule) {
    setScheduleDetailId(schedule.id)
  }

  function closeScheduleDetail() {
    setScheduleDetailId(null)
  }

  function editScheduleFromDetail() {
    if (!scheduleDetailTarget) return
    scheduleModal.openEdit(scheduleDetailTarget)
    setScheduleDetailId(null)
  }

  return {
    isDemo, canWrite, isOwner,

    // Loading covers two cases:
    //   1. Cloud trips fetch in flight (auth resolved, query pending)
    //   2. Auth still resolving but the hint tells us the user was
    //      signed in last session — avoid flashing demo while we wait
    cloudTripsLoading: (authResolving && wasSignedIn)
      || (!isDemo && myTrips === undefined && !tripsError),
    cloudTripsError:   !isDemo && tripsError && myTrips === undefined ? tripsError : null,
    // No `&& !currentTrip` belt needed: with `currentTrip` derived
    // from `myTrips`, the cache push + selectedTripId update + modal
    // close all batch into one React 18 commit. EmptyTrips no longer
    // races against the create / copy flow.
    cloudTripsEmpty:   !isDemo && myTrips !== undefined && myTrips.length === 0,
    refetchTrips,

    trips, selectedTrip, dateRange, display, items, dayTotal,
    schedules, tripTotal, grouped, isLoading,

    selectTrip, saveTrip, deleteTrip, onLeaveTrip, reorderTrips, handleMenuAction,
    setActiveDate,

    scheduleModal,
    scheduleDetailTarget,
    openScheduleDetail,
    closeScheduleDetail,
    editScheduleFromDetail,
    scheduleIsSaving: isSaving,
    onScheduleSave,
    onScheduleDelete,

    editTripOpen, setEditTripOpen,
    createTripOpen, setCreateTripOpen,
    copyTripOpen, setCopyTripOpen,
    copyTripSource,
    copyTripPending: copyTripMut.isPending,
    onCopyTrip,
    inviteOpen, setInviteOpen,
    membersOpen, setMembersOpen,
    signInOpen, setSignInOpen,

    currentTrip,
  }
}
