// src/features/schedule/hooks/useSchedulePageState.ts
// All non-rendering state + derived values + action callbacks for
// SchedulePage. Extracting this lets the page component itself read as
// pure layout orchestration: pick a few values from the returned bag,
// hand modals off to TripModalsHost, render.
//
// Hook order is intentional and matches the original inline order — if
// you reorder, double-check React's rules-of-hooks invariants survive.
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSchedules, useCreateSchedule, useUpdateSchedule, useDeleteSchedule } from './useSchedules'
import { useCopyTrip, useDeleteTrip, useMyTrips, useUpdateTrip } from '@/features/trips/hooks/useTrips'
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
  reorderTrips:     (fromIdx: number, toIdx: number) => void
  handleMenuAction: (key: MenuActionKey) => void

  // ─── Day timeline actions ─────────────────────────────────────
  openAdd:       () => void
  openEdit:      (s: Schedule) => void
  setActiveDate: (date: string | null) => void

  // ─── Modal state ──────────────────────────────────────────────
  // Flat fields rather than a nested object so the page can spread
  // selected slices into TripModalsHost without re-keying.
  scheduleModalOpen: boolean
  scheduleEditTarget: Schedule | null
  scheduleIsSaving:   boolean
  closeScheduleModal: () => void
  onScheduleSave:     (data: CreateScheduleInput) => Promise<void>
  onScheduleDelete:   () => Promise<void>

  editTripOpen:    boolean
  setEditTripOpen: (open: boolean) => void

  createTripOpen:    boolean
  setCreateTripOpen: (open: boolean) => void

  copyTripOpen:    boolean
  setCopyTripOpen: (open: boolean) => void
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
  const { state: authState } = useAuth(true)
  const uid           = authState.status === 'signed-in' ? authState.user.uid : undefined
  const authResolving = authState.status === 'loading'
  const wasSignedIn   = authState.status === 'loading' && authState.wasSignedIn
  const isDemo        = !uid && !wasSignedIn

  const currentTrip    = useTripStore(s => s.currentTrip)
  const setCurrentTrip = useTripStore(s => s.setCurrentTrip)
  const tripOrder      = useTripStore(s => s.tripOrder)
  const setTripOrder   = useTripStore(s => s.setTripOrder)

  const { data: myTrips, error: tripsError, refetch: refetchTrips } = useMyTrips(uid)

  const [activeDate,     setActiveDate]     = useState<string | null>(null)
  const [modalOpen,      setModalOpen]      = useState(false)
  const [editTarget,     setEditTarget]     = useState<Schedule | null>(null)
  const [editTripOpen,   setEditTripOpen]   = useState(false)
  const [createTripOpen, setCreateTripOpen] = useState(false)
  const [copyTripOpen,   setCopyTripOpen]   = useState(false)
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
  const tripTotal = schedules.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)

  const trips = isDemo ? demoSelection.trips : cloudTripsList
  // Compiler memoises `selectedTrip` — child components (TripHeaderCard
  // etc.) get a stable reference when nothing relevant changed.
  const selectedTrip = isDemo
    ? demoSelection.selectedTrip
    : cloudTripItem ? { ...cloudTripItem, members: memberChips } : null

  const createMut     = useCreateSchedule(tripId ?? '')
  const updateMut     = useUpdateSchedule(tripId ?? '')
  const deleteMut     = useDeleteSchedule(tripId ?? '')
  const updateTripMut = useUpdateTrip(uid)
  const deleteTripMut = useDeleteTrip(uid)
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
  const dayTotal = items.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)

  // ─── Action callbacks ─────────────────────────────────────────
  const selectTrip = isDemo
    ? demoSelection.selectTrip
    : (item: TripItem) => {
        const next = myTrips?.find(t => t.id === item.id)
        if (next) { setCurrentTrip(next); setActiveDate(null) }
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

  function handleMenuAction(key: MenuActionKey) {
    if (key === 'edit') { setEditTripOpen(true); return }
    // 'members' opens the roster/admin sheet (list + remove). 'share'
    // opens the invite-link sheet. They used to share one modal;
    // separating them matches the menu copy ("管理成員" vs "分享行程")
    // and keeps each sheet focused on a single responsibility. Demo
    // mode has no real tripId → sign-in prompt.
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
    if (key === 'copy') {
      if (isDemo)        { setSignInOpen(true); return }
      if (!currentTrip)  return
      setCopyTripOpen(true)
      return
    }
    toast.info(`${key} は開発中です`)
  }

  // Cloud-only — gate is in handleMenuAction. uid is guaranteed at this
  // point (signed-in branch) but we read auth state defensively for the
  // createTrip payload (ownerId, displayName).
  async function onCopyTrip(input: CopyTripInput) {
    if (!currentTrip || !uid || authState.status !== 'signed-in') return
    try {
      const { trip, copiedSchedules, copiedPlanItems, orphanedSchedules } =
        await copyTripMut.mutateAsync({ source: currentTrip, input, user: authState.user })
      setCurrentTrip(trip)
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

  function openAdd()             { setEditTarget(null); setModalOpen(true) }
  function openEdit(s: Schedule) { setEditTarget(s);    setModalOpen(true) }
  function closeScheduleModal()  { setModalOpen(false); setEditTarget(null) }

  // Demo save → close form, pop sign-in prompt. Cloud save → Firestore
  // write with optimistic updates (hook surfaces toast on failure).
  async function onScheduleSave(data: CreateScheduleInput) {
    if (isDemo) { setModalOpen(false); setSignInOpen(true); return }
    if (!editTarget && !uid) { toast.error('ログイン準備中です。少々お待ちください'); return }
    try {
      if (editTarget) {
        await updateMut.mutateAsync({ scheduleId: editTarget.id, updates: data })
      } else {
        await createMut.mutateAsync({ input: data, userId: uid! })
      }
      closeScheduleModal()
    } catch { /* hook onError already surfaced the toast */ }
  }
  async function onScheduleDelete() {
    if (!editTarget) { closeScheduleModal(); return }
    if (isDemo) { setModalOpen(false); setSignInOpen(true); return }
    try {
      await deleteMut.mutateAsync(editTarget.id)
      closeScheduleModal()
    } catch { /* hook onError already surfaced the toast */ }
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
    cloudTripsEmpty:   !isDemo && myTrips !== undefined && myTrips.length === 0,
    refetchTrips,

    trips, selectedTrip, dateRange, display, items, dayTotal,
    schedules, tripTotal, grouped, isLoading,

    selectTrip, saveTrip, deleteTrip, reorderTrips, handleMenuAction,
    openAdd, openEdit, setActiveDate,

    scheduleModalOpen:  modalOpen,
    scheduleEditTarget: editTarget,
    scheduleIsSaving:   isSaving,
    closeScheduleModal,
    onScheduleSave,
    onScheduleDelete,

    editTripOpen, setEditTripOpen,
    createTripOpen, setCreateTripOpen,
    copyTripOpen, setCopyTripOpen,
    copyTripPending: copyTripMut.isPending,
    onCopyTrip,
    inviteOpen, setInviteOpen,
    membersOpen, setMembersOpen,
    signInOpen, setSignInOpen,

    currentTrip,
  }
}
