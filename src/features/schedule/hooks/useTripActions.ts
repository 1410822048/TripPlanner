// src/features/schedule/hooks/useTripActions.ts
// Trip-level actions behind the schedule page: switching, editing,
// deleting, leaving, reordering and copying. Each one has the same shape
// — a demo branch that defers to the local store, and a cloud branch that
// keeps the visible selection coherent while a mutation is in flight.
import { useCopyTrip, useDeleteTrip, useLeaveTrip, useUpdateTrip } from '@/features/trips/hooks/useTrips'
import type { UseTripSelectionResult } from '@/features/trips/hooks/useTripSelection'
import type { CopyTripInput } from '@/features/trips/services/tripCopy'
import type { AuthState } from '@/hooks/useAuth'
import type { CreateTripInput, Trip } from '@/types'
import type { TripItem } from '@/features/trips/types'
import { toLocalDateString } from '@/utils/dates'
import { toast } from '@/shared/toast'

export interface TripActions {
  selectTrip:   (item: TripItem) => void
  saveTrip:     (data: TripItem) => void
  deleteTrip:   (deletedId: string) => void
  /** Non-owner self-leave of the current trip (MembersModal footer). */
  onLeaveTrip:  () => void
  reorderTrips: (fromIdx: number, toIdx: number) => void
  onCopyTrip:   (input: CopyTripInput) => Promise<void>
  copyTripPending: boolean
}

export function useTripActions(opts: {
  isDemo:         boolean
  demoSelection:  UseTripSelectionResult
  uid:            string | undefined
  authState:      AuthState
  myTrips:        Trip[] | undefined
  currentTrip:    Trip | null
  cloudTripsList: TripItem[]
  setSelectedTripId: (id: string | null) => void
  setTripOrder:      (ids: string[]) => void
  /** Day selection is trip-scoped, so any switch has to clear it. */
  resetActiveDate:      () => void
  clearScheduleDetail:  () => void
  closeMembers:         () => void
  copyTripSource:       Trip | null
  closeCopyTrip:        () => void
}): TripActions {
  const {
    isDemo, demoSelection, uid, authState, myTrips, currentTrip, cloudTripsList,
    setSelectedTripId, setTripOrder, resetActiveDate, clearScheduleDetail,
    closeMembers, copyTripSource, closeCopyTrip,
  } = opts

  const updateTripMut = useUpdateTrip(uid)
  const deleteTripMut = useDeleteTrip(uid)
  const leaveTripMut  = useLeaveTrip(uid)
  const copyTripMut   = useCopyTrip()

  const selectTrip = (item: TripItem) => {
    clearScheduleDetail()
    if (isDemo) {
      demoSelection.selectTrip(item)
      return
    }
    // myTrips lookup retained as a "trip exists" gate — picking an id the
    // user no longer has access to would just produce a null
    // useCurrentTrip downstream and a confused UI.
    if (myTrips?.some(t => t.id === item.id)) {
      setSelectedTripId(item.id)
      resetActiveDate()
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
    if (data.defaultCountryCode !== currentTrip.defaultCountryCode)
      updates.defaultCountryCode = data.defaultCountryCode
    resetActiveDate()
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
      resetActiveDate()
    }
    deleteTripMut.mutate(deletedId, {
      onSuccess: () => toast.success('已刪除旅程'),
      onError:   () => { if (wasCurrent && restoreId) setSelectedTripId(restoreId) },
    })
  }

  // Cloud-only: a non-owner leaves the current trip (MembersModal footer).
  // Mirrors deleteTrip's "switch to the next surviving trip BEFORE the
  // mutation" so the UI never renders against a trip vanishing under it.
  // The modal is closed first — after the switch, currentTrip becomes a
  // different trip (or null), and leaving the modal open would show the
  // wrong trip's members. On failure we restore the selection (the user
  // is still a member); the optimistic rollback + onSettled invalidate in
  // useLeaveTrip re-sync the trip list.
  function onLeaveTrip() {
    const leavingId = currentTrip?.id
    if (!leavingId) return
    closeMembers()
    const remaining = (myTrips ?? []).filter(t => t.id !== leavingId)
    setSelectedTripId(remaining[0]?.id ?? null)
    resetActiveDate()
    leaveTripMut.mutate(leavingId, {
      onSuccess: () => toast.success('已退出旅程'),
      onError:   () => setSelectedTripId(leavingId),
    })
  }

  // Cloud reorder: persist a per-user trip-id order in the zustand store
  // (localStorage-backed). The caller's list memo applies this order on
  // render, so the splice + setTripOrder is sufficient — no Firestore
  // write involved (ordering is a personal view preference, not shared
  // trip metadata).
  const reorderTrips = isDemo ? demoSelection.reorderTrips : (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return
    const ids = cloudTripsList.map(t => t.id)
    const [moved] = ids.splice(fromIdx, 1)
    if (!moved) return
    ids.splice(toIdx, 0, moved)
    setTripOrder(ids)
  }

  // Cloud-only — the gate is in handleMenuAction. uid is guaranteed here
  // (signed-in branch) but auth state is read defensively for the
  // createTrip payload (ownerId, displayName).
  async function onCopyTrip(input: CopyTripInput) {
    // Read from the snapshot, not currentTrip — by the time this fires the
    // user is mid-confirm and currentTrip could theoretically change under
    // us (rare but possible). The snapshot is what the modal is showing,
    // so use the same value for the mutation.
    if (!copyTripSource || !uid || authState.status !== 'signed-in') return
    try {
      const { trip, copiedSchedules, copiedPlanItems, orphanedSchedules } =
        await copyTripMut.mutateAsync({ source: copyTripSource, input, user: authState.user })
      // The modal closes cleanly because its render gate (copyTripSource +
      // copyTripOpen) doesn't depend on currentTrip. setSelectedTripId can
      // flip currentTrip = newTrip in the same commit; the modal doesn't
      // see it.
      setSelectedTripId(trip.id)
      resetActiveDate()
      closeCopyTrip()
      const parts = [`已建立「${trip.title}」`]
      if (input.copySchedules) parts.push(`行程 ${copiedSchedules} 件`)
      if (input.copyPlanning)  parts.push(`計畫 ${copiedPlanItems} 件`)
      toast.success(parts.join(' · '))
      if (orphanedSchedules > 0) {
        toast.info(`${orphanedSchedules} 個行程位於新的日期範圍之外`)
      }
    } catch (e) {
      toast.error(e instanceof Error ? `複製失敗：${e.message}` : '複製失敗')
    }
  }

  return {
    selectTrip, saveTrip, deleteTrip, onLeaveTrip, reorderTrips, onCopyTrip,
    copyTripPending: copyTripMut.isPending,
  }
}
