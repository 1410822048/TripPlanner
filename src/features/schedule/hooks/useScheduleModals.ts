// src/features/schedule/hooks/useScheduleModals.ts
// Every modal SchedulePage can open, and nothing else. Deliberately blind
// to trips and schedules: it only needs to know whether the user is in
// demo mode (cloud-only actions divert to the sign-in prompt) and which
// trip a copy would snapshot.
import { useEffect, useState } from 'react'
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

  createTripOpen:    boolean
  setCreateTripOpen: (open: boolean) => void

  copyTripOpen:    boolean
  setCopyTripOpen: (open: boolean) => void
  /** Snapshot of the trip taken when the copy modal opens. TripModalsHost
   *  renders CopyTripModal off this (not `currentTrip`) so post-mutation
   *  trip switches don't re-key the modal during its close transition. */
  copyTripSource:  Trip | null

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
  const [editTripOpen,   setEditTripOpen]   = useState(false)
  const [createTripOpen, setCreateTripOpen] = useState(false)
  const [copyTripOpen,   setCopyTripOpen]   = useState(false)
  // Decouples the copy modal's identity (key + source) from currentTrip so
  // the post-mutation `setSelectedTripId(newTrip.id)` doesn't re-key it
  // mid-close — that re-key caused a 3-frame flash (close→open→close),
  // because the key changed from sourceId to newTripId in the same render
  // where copyTripOpen was still true. The snapshot stays until next open.
  const [copyTripSource, setCopyTripSource] = useState<Trip | null>(null)
  const [signInOpen,     setSignInOpen]     = useState(false)
  const [inviteOpen,     setInviteOpen]     = useState(false)
  const [inviteScannerOpen, setInviteScannerOpen] = useState(false)
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
    createTripOpen, setCreateTripOpen,
    copyTripOpen, setCopyTripOpen,
    copyTripSource,
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
