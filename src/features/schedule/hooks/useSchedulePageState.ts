// src/features/schedule/hooks/useSchedulePageState.ts
// Composition layer for SchedulePage: resolves demo-vs-cloud, derives the
// display data, and stitches together the three concern-scoped hooks
// (modals / trip actions / schedule actions) into the single bag the page
// and TripModalsHost read from.
//
// The bag stays a single entry point on purpose — splitting the state out
// to the components would scatter it back across the tree.
import { useState } from 'react'
import { useSchedules } from './useSchedules'
import { useScheduleActions } from './useScheduleActions'
import { useScheduleModals } from './useScheduleModals'
import { useTripActions } from './useTripActions'
import { useMyTrips } from '@/features/trips/hooks/useTrips'
import { useCurrentTrip } from '@/features/trips/hooks/useCurrentTrip'
import type { CopyTripInput } from '@/features/trips/services/tripCopy'
import { useTripSelection } from '@/features/trips/hooks/useTripSelection'
import { useCanWrite, useIsTripOwner } from '@/features/trips/hooks/useTripRole'
import { useClientCompatibility } from '@/hooks/useClientCompatibility'
import { useMembers } from '@/features/members/hooks/useMembers'
import { membersToTripMembers } from '@/features/members/utils'
import { useTripStore } from '@/store/tripStore'
import { useAuth } from '@/hooks/useAuth'
import type { UseFormModalResult } from '@/hooks/useFormModal'
import type { CreateScheduleInput, Schedule, Trip } from '@/types'
import type { MenuActionKey, TripItem } from '@/features/trips/types'
import { MOCK_SCHEDULES } from '../mocks'
import { buildDateRange, groupByDate } from '../utils'
import { toLocalDateString } from '@/utils/dates'

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
    defaultCountryCode: trip.defaultCountryCode,
  }
}

export interface SchedulePageState {
  // ─── Mode & guards ────────────────────────────────────────────
  isDemo:   boolean
  canWrite: boolean
  /** Role-only half of `canWrite` — blame the role before the epoch when
   *  wording blocked states (a viewer stays a viewer after updating). */
  roleCanWrite: boolean
  /** App-wide Schema Epoch capability; true in demo mode. */
  writeCompatible: boolean
  /** PURE ownership identity — never folded with schema compatibility. */
  isOwner:  boolean
  /** `isOwner && writeCompatible` — for owner-only write affordances. */
  canOwnerWrite: boolean

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
  saveTrip:         (data: TripItem) => boolean
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

  inviteScannerOpen:    boolean
  setInviteScannerOpen: (open: boolean) => void

  membersOpen:    boolean
  setMembersOpen: (open: boolean) => void

  signInOpen:    boolean
  setSignInOpen: (open: boolean) => void

  /** True when any TripModalsHost-owned modal is open. SchedulePage gates
   *  the lazy TripModalsHost mount on this, so the modal chunk stays out
   *  of the initial bundle until the first open. */
  hasOpenModal: boolean

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
  const { state: authState } = useAuth()
  const uid           = authState.status === 'signed-in' ? authState.user.uid : undefined
  const authResolving = authState.status === 'loading'
  const wasSignedIn   = authState.status === 'loading' && authState.wasSignedIn
  const isDemo        = !uid && !wasSignedIn

  const currentTrip       = useCurrentTrip()
  const setSelectedTripId = useTripStore(s => s.setSelectedTripId)
  const tripOrder         = useTripStore(s => s.tripOrder)
  const setTripOrder      = useTripStore(s => s.setTripOrder)

  const { data: myTrips, error: tripsError, refetch: refetchTrips } = useMyTrips(uid)

  // Stored WITH its trip id, not as a bare date — see the derivation below.
  const [activeDay, setActiveDay] = useState<{ tripId: string; date: string } | null>(null)
  const modals = useScheduleModals({ isDemo, currentTrip })

  const demoSelection = useTripSelection(() => setActiveDay(null))

  // Compiler memoises both `cloudTripItem` and `cloudTripsList` based
  // on inferred deps. Apply the user's saved order from drag-to-reorder.
  // Trips not in the saved list (newly joined / created since the last
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
  // Day selection is trip-scoped, so it is keyed to the trip it was made on.
  // Range-checking a bare date is not enough: two trips can legitimately share
  // dates (overlapping travel, or a copied trip), and then deleting or leaving
  // one would silently carry its day over to the next trip instead of landing
  // on that trip's first day.
  const activeDate = activeDay && activeDay.tripId === tripId ? activeDay.date : null
  const setActiveDate = (date: string | null) => {
    setActiveDay(date && tripId ? { tripId, date } : null)
  }
  const { data: fbSchedules, isLoading } = useSchedules(isDemo ? undefined : tripId)
  const { data: fbMembers } = useMembers(isDemo ? undefined : tripId)
  // Viewers can read schedules but not create/edit/delete — mirrors the
  // canWrite gate in firestore.rules. Hide the affordances they can't
  // actually use (add buttons in DayTimeline, delete in the form modal).
  // An out-of-date bundle has every write refused by the global mutation
  // guard, so fold that in alongside the role gate rather than offering
  // affordances that would silently do nothing. Demo passes through — those
  // writes never reach Firestore and the affordance is the sign-in CTA.
  // `isOwner` stays PURE identity; compatibility is exposed separately as
  // `canOwnerWrite`. Folding it into the identity makes an owner momentarily
  // stop being an owner, which elsewhere tears down mid-edit forms.
  const { updateRequired } = useClientCompatibility()
  const writeCompatible = isDemo || !updateRequired
  const roleCanWrite = useCanWrite(isDemo ? undefined : tripId, isDemo)
  const canWrite = roleCanWrite && writeCompatible
  const isOwner  = useIsTripOwner(isDemo ? undefined : tripId, isDemo)
  const canOwnerWrite = isOwner && writeCompatible
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
  const scheduleDetailTarget = modals.scheduleDetailId
    ? schedules.find(schedule => schedule.id === modals.scheduleDetailId) ?? null
    : null

  const trips = isDemo ? demoSelection.trips : cloudTripsList
  // Compiler memoises `selectedTrip` — child components (TripHeaderCard
  // etc.) get a stable reference when nothing relevant changed.
  const selectedTrip = isDemo
    ? demoSelection.selectedTrip
    : cloudTripItem ? { ...cloudTripItem, members: memberChips } : null

  const tripActions = useTripActions({
    isDemo, demoSelection, uid, authState, myTrips, currentTrip, cloudTripsList,
    setSelectedTripId, setTripOrder,
    resetActiveDate:     () => setActiveDate(null),
    clearScheduleDetail: modals.closeScheduleDetail,
    closeMembers:        () => modals.setMembersOpen(false),
    copyTripSource:      modals.copyTripSource,
    closeCopyTrip:       () => modals.setCopyTripOpen(false),
  })

  const scheduleActions = useScheduleActions({
    isDemo, uid, tripId, schedules,
    scheduleModal: modals.scheduleModal,
    openSignIn:    () => modals.setSignInOpen(true),
  })

  // ─── Derived display state ────────────────────────────────────
  const dateRange = selectedTrip
    ? buildDateRange(selectedTrip.startDate, selectedTrip.endDate)
    : []
  const display = (activeDate && dateRange.includes(activeDate)) ? activeDate : dateRange[0]
  const items   = display ? (grouped[display] ?? []) : []
  // dayTotal stays inline — items per day are small (≤ 20 typical) so
  // hoisting it costs more than it saves.
  const dayTotal = items.reduce((s, i) => s + (i.estimatedCostMinor ?? 0), 0)

  function editScheduleFromDetail() {
    if (!scheduleDetailTarget) return
    modals.scheduleModal.openEdit(scheduleDetailTarget)
    modals.closeScheduleDetail()
  }

  return {
    isDemo, canWrite, roleCanWrite, writeCompatible, isOwner, canOwnerWrite,

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

    selectTrip:   tripActions.selectTrip,
    saveTrip:     tripActions.saveTrip,
    deleteTrip:   tripActions.deleteTrip,
    onLeaveTrip:  tripActions.onLeaveTrip,
    reorderTrips: tripActions.reorderTrips,
    handleMenuAction: modals.handleMenuAction,
    setActiveDate,

    scheduleModal: modals.scheduleModal,
    scheduleDetailTarget,
    openScheduleDetail:  modals.openScheduleDetail,
    closeScheduleDetail: modals.closeScheduleDetail,
    editScheduleFromDetail,
    scheduleIsSaving: scheduleActions.isSaving,
    onScheduleSave:   scheduleActions.onScheduleSave,
    onScheduleDelete: scheduleActions.onScheduleDelete,

    editTripOpen:      modals.editTripOpen,
    setEditTripOpen:   modals.setEditTripOpen,
    createTripOpen:    modals.createTripOpen,
    setCreateTripOpen: modals.setCreateTripOpen,
    copyTripOpen:      modals.copyTripOpen,
    setCopyTripOpen:   modals.setCopyTripOpen,
    copyTripSource:    modals.copyTripSource,
    copyTripPending:   tripActions.copyTripPending,
    onCopyTrip:        tripActions.onCopyTrip,
    inviteOpen:        modals.inviteOpen,
    setInviteOpen:     modals.setInviteOpen,
    inviteScannerOpen: modals.inviteScannerOpen,
    setInviteScannerOpen: modals.setInviteScannerOpen,
    membersOpen:       modals.membersOpen,
    setMembersOpen:    modals.setMembersOpen,
    signInOpen:        modals.signInOpen,
    setSignInOpen:     modals.setSignInOpen,
    hasOpenModal:      modals.anyOpen || !!scheduleDetailTarget,

    currentTrip,
  }
}
