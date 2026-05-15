// src/features/schedule/components/TripModalsHost.tsx
// All seven modals SchedulePage owns rendered in one place. Lifted out
// of the page so the page itself reads as layout orchestration; the
// modals are each conditionally rendered + keyed for the
// fresh-state-on-open pattern (see comments per modal).
//
// State + handlers come from useSchedulePageState — this component
// just picks the slices each modal needs and wires them up. Adding a
// new modal: extend SchedulePageState with the open/handler fields,
// then add a block here. Don't widen the page's surface.
import { lazy, Suspense } from 'react'
import ScheduleFormModal from './ScheduleFormModal'
import EditTripModal from '@/features/trips/components/EditTripModal'
import CopyTripModal from '@/features/trips/components/CopyTripModal'
import CreateTripModal from '@/features/trips/components/CreateTripModal'
import MembersModal from '@/features/members/components/MembersModal'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import type { SchedulePageState } from '../hooks/useSchedulePageState'

// Lazy-loaded: InviteModal pulls in qrcode.react (~30 KB raw / ~10 KB
// gzip) for the share-link QR code, which has no business being on the
// initial-render critical path. The chunk loads when the user opens
// "share trip" — by which point the page has long settled, so the brief
// Suspense fallback (<50ms typical) is invisible.
const InviteModal = lazy(() => import('@/features/trips/invites/InviteModal'))

interface Props {
  state: SchedulePageState
}

export default function TripModalsHost({ state }: Props) {
  const {
    isDemo, canWrite, selectedTrip, schedules, currentTrip, display,
    scheduleModalOpen, scheduleEditTarget, scheduleIsSaving,
    closeScheduleModal, onScheduleSave, onScheduleDelete,
    editTripOpen,    setEditTripOpen,
    createTripOpen,  setCreateTripOpen,
    copyTripOpen,    setCopyTripOpen, copyTripPending, onCopyTrip,
    inviteOpen,      setInviteOpen,
    membersOpen,     setMembersOpen,
    signInOpen,      setSignInOpen,
    saveTrip,
  } = state

  return (
    <>
      {/* Conditionally render + keyed for fresh state per open (see the
          parallel note in ExpensePage). */}
      {scheduleModalOpen && selectedTrip && (
        <ScheduleFormModal
          key={scheduleEditTarget?.id ?? 'new'}
          isOpen
          editTarget={scheduleEditTarget}
          defaultDate={display ?? new Date().toISOString().slice(0, 10)}
          // Trip date range — the picker disables days outside this
          // window and the form blocks save with an inline message if
          // an edit somehow lands a stored value out of range (e.g.
          // owner shrunk the trip after the schedule was created).
          tripStartDate={selectedTrip.startDate}
          tripEndDate={selectedTrip.endDate}
          isSaving={scheduleIsSaving}
          onClose={closeScheduleModal}
          onSave={onScheduleSave}
          onDelete={scheduleEditTarget && canWrite ? onScheduleDelete : undefined}
        />
      )}

      {/* Conditionally render + keyed so every open initializes from
          the current trip via useState (no sync-in-effect; no stale
          state after a cancel-then-reopen). */}
      {editTripOpen && selectedTrip && (
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

      {!isDemo && currentTrip && copyTripOpen && (
        // Conditionally rendered + keyed so every open initialises form
        // state from props (matches the EditTrip / Schedule modal pattern).
        <CopyTripModal
          key={currentTrip.id}
          isOpen
          source={currentTrip}
          isSaving={copyTripPending}
          onClose={() => setCopyTripOpen(false)}
          onConfirm={onCopyTrip}
        />
      )}

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
    </>
  )
}
