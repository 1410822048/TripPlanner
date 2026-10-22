// src/features/schedule/hooks/useScheduleModals.ts
// Every modal SchedulePage can open, and nothing else. Deliberately blind
// to trips and schedules: it only needs to know whether the user is in
// demo mode (cloud-only actions divert to the sign-in prompt) and which
// trip a copy would snapshot.
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useUid } from '@/hooks/useAuth'
import { useFormModal, type UseFormModalResult } from '@/hooks/useFormModal'
import type { Schedule, Trip } from '@/types'
import type { MenuActionKey } from '@/features/trips/types'
import { toast } from '@/shared/toast'

export interface ScheduleModalsState {
  scheduleModal:    UseFormModalResult<Schedule>
  scheduleDetailId: string | null
  openScheduleDetail:  (schedule: Schedule) => void
  closeScheduleDetail: () => void

  editTripOpen:    boolean
  setEditTripOpen: (open: boolean) => void
  /** Draft-bearing form: open state is NOT derived closed on a trip / account
   *  switch (that would eat the draft). It is stamped at open and the save
   *  handler refuses with FORM_SCOPE_CHANGED_MESSAGE when this is true. */
  editTripScopeChanged: boolean
  editTripSaveError:    string | null
  setEditTripSaveError: (message: string | null) => void
  /** Bumped per open so the host remounts a fresh form instance. */
  editTripGeneration:   number

  createTripOpen:    boolean
  setCreateTripOpen: (open: boolean) => void
  /** Bumped per open: CreateTripModal is rendered per open with this key,
   *  so a write that settles after the sheet was dismissed and reopened
   *  cannot touch the new instance (useAwaitedSave liveness). */
  createTripGeneration: number

  copyTripOpen:    boolean
  setCopyTripOpen: (open: boolean) => void
  /** Snapshot of the trip taken when the copy modal opens. TripModalsHost
   *  renders CopyTripModal off this (not `currentTrip`) so post-mutation
   *  trip switches don't re-key the modal during its close transition. */
  copyTripSource:  Trip | null
  /** The account the copy sheet was opened under. onCopyTrip compares it
   *  with the CURRENT uid and refuses on mismatch — the old uid is not a
   *  credential to keep writing with. */
  copyTripOpenedUid: string | undefined

  inviteOpen:    boolean
  setInviteOpen: (open: boolean) => void

  inviteScannerOpen:    boolean
  setInviteScannerOpen: (open: boolean) => void

  membersOpen:    boolean
  setMembersOpen: (open: boolean) => void

  signInOpen:    boolean
  setSignInOpen: (open: boolean) => void

  handleMenuAction: (key: MenuActionKey) => void

  /** True when any modal owned here is open. The page ORs in the detail
   *  sheet, which is gated on a schedule it has to resolve first. */
  anyOpen: boolean
}

export function useScheduleModals(opts: {
  isDemo:      boolean
  currentTrip: Trip | null
}): ScheduleModalsState {
  const { isDemo, currentTrip } = opts

  // Same scope capture as useFeatureListPage: the save/delete mutations bind
  // to the live trip id, so a form opened on trip A must refuse to write
  // after a background reselect swapped it to trip B.
  const uid = useUid()
  const scheduleModal = useFormModal<Schedule>({ tripId: currentTrip?.id, uid })
  const [scheduleDetailId, setScheduleDetailId] = useState<string | null>(null)
  // Edit-trip is a DRAFT form (see useFormModal's scope strategy): stamp
  // {tripId, uid} at open, never auto-close, refuse at save on mismatch.
  type DraftScope = { tripId: string | undefined; uid: string | undefined }
  const [editTripOpenedOn, setEditTripOpenedOn] = useState<DraftScope | null>(null)
  const [editTripSaveError, setEditTripSaveError] = useState<string | null>(null)
  const generation = useRef({ edit: 0, create: 0 })
  const [editTripGeneration,   setEditTripGeneration]   = useState(0)
  const [createTripGeneration, setCreateTripGeneration] = useState(0)
  const editTripOpen = editTripOpenedOn !== null
  // Fail-closed: a vanished trip (kick / remote delete) or signed-out
  // session reads as "changed", never as "still fine".
  const editTripScopeChanged = editTripOpenedOn !== null
    && (editTripOpenedOn.tripId !== currentTrip?.id || editTripOpenedOn.uid !== uid)
  const setEditTripOpen = (open: boolean) => {
    if (open) setEditTripGeneration(++generation.current.edit)
    setEditTripOpenedOn(open ? { tripId: currentTrip?.id, uid } : null)
    setEditTripSaveError(null)
  }
  const [createTripOpen, setCreateTripOpenState] = useState(false)
  const setCreateTripOpen = (open: boolean) => {
    if (open) setCreateTripGeneration(++generation.current.create)
    setCreateTripOpenState(open)
  }
  const [copyTripOpen,   setCopyTripOpen]   = useState(false)
  const [copyTripOpenedUid, setCopyTripOpenedUid] = useState<string | undefined>(undefined)
  // Decouples the copy modal's identity (key + source) from currentTrip so
  // the post-mutation `setSelectedTripId(newTrip.id)` doesn't re-key it
  // mid-close — that re-key caused a 3-frame flash (close→open→close),
  // because the key changed from sourceId to newTripId in the same render
  // where copyTripOpen was still true. The snapshot stays until next open.
  const [copyTripSource, setCopyTripSource] = useState<Trip | null>(null)
  const [signInOpen,     setSignInOpen]     = useState(false)
  const [inviteScannerOpen, setInviteScannerOpen] = useState(false)

  // Invite / Members are MANAGEMENT modals bound to the live trip prop —
  // generate/revoke/remove/transfer/leave would silently target trip B after
  // a background reselect. They hold no draft, so instead of refusing at
  // save time (the form-modal strategy) their open state is stamped with the
  // {tripId, uid} it was opened under and DERIVES closed the moment either
  // changes. TripModalsHost additionally keys them by trip id so a reopen
  // never resurrects a previous trip's pending confirm.
  type OpenedScope = { tripId: string | undefined; uid: string | undefined }
  const [inviteOpenedOn,  setInviteOpenedOn]  = useState<OpenedScope | null>(null)
  const [membersOpenedOn, setMembersOpenedOn] = useState<OpenedScope | null>(null)
  const scopeStillCurrent = (s: OpenedScope | null) =>
    s !== null && s.tripId === currentTrip?.id && s.uid === uid
  // A mismatch is a scope TRANSITION, not re-derivable view state: the stamp
  // is cleared permanently on first mismatch (render-phase adjust, so the
  // close is synchronous). Deriving alone would let an A→B→A round trip
  // re-match the old stamp and reopen the modal on its own.
  if (inviteOpenedOn !== null && !scopeStillCurrent(inviteOpenedOn)) {
    setInviteOpenedOn(null)
  }
  if (membersOpenedOn !== null && !scopeStillCurrent(membersOpenedOn)) {
    setMembersOpenedOn(null)
  }
  const inviteOpen  = scopeStillCurrent(inviteOpenedOn)
  const membersOpen = scopeStillCurrent(membersOpenedOn)
  const setInviteOpen = (open: boolean) =>
    setInviteOpenedOn(open ? { tripId: currentTrip?.id, uid } : null)
  const setMembersOpen = (open: boolean) =>
    setMembersOpenedOn(open ? { tripId: currentTrip?.id, uid } : null)

  // AccountPage's "Planner" card navigates here with state.openCreateTrip
  // = true to deep-link straight into the create-trip flow. Consume the
  // flag once, open the modal, and clear via replace so refresh /
  // back-button doesn't re-trigger.
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const s = location.state as { openCreateTrip?: boolean } | null
    if (!s?.openCreateTrip) return
    setCreateTripOpen(true)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])

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
          // Snapshot the source NOW — the modal's key + source props read
          // from this snapshot so the post-mutation trip switch doesn't
          // re-key the modal mid-close.
          setCopyTripSource(currentTrip)
          setCopyTripOpenedUid(uid)
          setCopyTripOpen(true)
        }
        return
      default: {
        // Exhaustiveness check: if MenuActionKey gains a member, TS will
        // flag this assignment until the new case is handled.
        const _exhaustive: never = key
        toast.info(`${_exhaustive} 尚在開發中`)
      }
    }
  }

  return {
    scheduleModal,
    scheduleDetailId,
    openScheduleDetail:  (schedule: Schedule) => setScheduleDetailId(schedule.id),
    closeScheduleDetail: () => setScheduleDetailId(null),

    editTripOpen, setEditTripOpen,
    editTripScopeChanged, editTripSaveError, setEditTripSaveError, editTripGeneration,
    createTripOpen, setCreateTripOpen, createTripGeneration,
    copyTripOpen, setCopyTripOpen,
    copyTripSource, copyTripOpenedUid,
    inviteOpen, setInviteOpen,
    inviteScannerOpen, setInviteScannerOpen,
    membersOpen, setMembersOpen,
    signInOpen, setSignInOpen,

    handleMenuAction,

    anyOpen:
      scheduleModal.isOpen ||
      editTripOpen ||
      createTripOpen ||
      copyTripOpen ||
      inviteOpen ||
      inviteScannerOpen ||
      membersOpen ||
      signInOpen,
  }
}
