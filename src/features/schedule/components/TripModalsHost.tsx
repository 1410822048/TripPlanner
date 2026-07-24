// src/features/schedule/components/TripModalsHost.tsx
// All SchedulePage-owned modals rendered in one place. Lifted out
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
import ScheduleReadonlyModal from './ScheduleReadonlyModal'
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
const InviteQrScannerModal = lazy(() => import('@/features/trips/invites/InviteQrScannerModal'))

interface Props {
  state: SchedulePageState
}

export default function TripModalsHost({ state }: Props) {
  const {
    isDemo, canWrite, selectedTrip, schedules, currentTrip, display,
    scheduleModal, scheduleDetailTarget, closeScheduleDetail, editScheduleFromDetail, scheduleIsSaving,
    onScheduleSave, onScheduleDelete,
    editTripOpen,    setEditTripOpen,
    createTripOpen,  setCreateTripOpen,
    copyTripOpen,    setCopyTripOpen, copyTripSource, copyTripPending, onCopyTrip,
    inviteOpen,      setInviteOpen,
    inviteScannerOpen, setInviteScannerOpen,
    membersOpen,     setMembersOpen,
    signInOpen,      setSignInOpen,
    saveTrip,        onLeaveTrip,
  } = state

  return (
    <>
      {/* Conditionally render + keyed for fresh state per open (see the
          parallel note in ExpensePage). */}
      {scheduleModal.isOpen && selectedTrip && (
        <ScheduleFormModal
          key={scheduleModal.key}
          isOpen
          tripId={selectedTrip.id}
          editTarget={scheduleModal.editTarget}
          defaultDate={display ?? new Date().toISOString().slice(0, 10)}
          // Trip date range — the picker disables days outside this
          // window and the form blocks save with an inline message if
          // an edit somehow lands a stored value out of range (e.g.
          // owner shrunk the trip after the schedule was created).
          tripStartDate={selectedTrip.startDate}
          tripEndDate={selectedTrip.endDate}
          schedules={schedules}
          defaultCountryCode={selectedTrip.defaultCountryCode}
          isSaving={scheduleIsSaving}
          saveError={scheduleModal.saveError}
          onClose={scheduleModal.close}
          onSave={onScheduleSave}
          onDelete={scheduleModal.editTarget && canWrite ? onScheduleDelete : undefined}
        />
      )}

      {scheduleDetailTarget && selectedTrip && (
        <ScheduleReadonlyModal
          isOpen
          schedule={scheduleDetailTarget}
          currency={selectedTrip.currency}
          onClose={closeScheduleDetail}
          onEdit={canWrite ? editScheduleFromDetail : undefined}
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

      {!isDemo && copyTripSource && copyTripOpen && (
        // Conditionally rendered + keyed on the SNAPSHOT (not currentTrip)
        // so the post-confirm `setSelectedTripId(newTrip.id)` doesn't
        // re-key this modal mid-close. The snapshot was captured when
        // the modal opened — see useSchedulePageState's handleMenuAction
        // 'copy' branch.
        <CopyTripModal
          key={copyTripSource.id}
          isOpen
          source={copyTripSource}
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
            onLeave={onLeaveTrip}
          />
        </>
      )}

      {inviteScannerOpen && (
        <Suspense fallback={null}>
          <InviteQrScannerModal
            isOpen
            onClose={() => setInviteScannerOpen(false)}
          />
        </Suspense>
      )}

      <SignInPromptModal
        isOpen={signInOpen}
        onClose={() => setSignInOpen(false)}
        reason="若要儲存行程，"
      />
    </>
  )
}
