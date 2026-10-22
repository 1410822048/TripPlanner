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
import { lazy, Suspense, useState } from 'react'
import ScheduleFormModal from './ScheduleFormModal'
import ScheduleReadonlyModal from './ScheduleReadonlyModal'
import EditTripModal from '@/features/trips/components/EditTripModal'
import CopyTripModal from '@/features/trips/components/CopyTripModal'
import CreateTripModal from '@/features/trips/components/CreateTripModal'
import MembersModal from '@/features/members/components/MembersModal'
import SignInPromptModal from '@/features/auth/components/SignInPromptModal'
import type { SchedulePageState } from '../hooks/useSchedulePageState'
import type { TripItem } from '@/features/trips/types'
import { FORM_SCOPE_CHANGED_MESSAGE } from '@/hooks/useFormModal'
import { toLocalDateString } from '@/utils/dates'

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

/** One open of the edit-trip sheet. `editTarget` is frozen at mount (the
 *  host keys this per open), so a background reselect cannot swap the
 *  draft for another trip's data; the stamped scope decides at save time. */
function EditTripSheet({ initialTarget, scheduleDates, scopeChanged, saveError, saveTrip, onClose, onSaved }: {
  initialTarget: TripItem | null
  scheduleDates: string[]
  scopeChanged:  boolean
  saveError:     string | null
  saveTrip:      (data: TripItem) => boolean
  onClose:       () => void
  onSaved:       (message: string | null) => void
}) {
  const [editTarget] = useState(initialTarget)
  if (!editTarget) return null
  return (
    <EditTripModal
      isOpen
      editTarget={editTarget}
      scheduleDates={scheduleDates}
      saveError={saveError}
      onClose={onClose}
      onSave={data => {
        // Scope first: it is a refusal that keeps the draft, and it must win
        // over any branch that could clear or close the form.
        if (scopeChanged) { onSaved(FORM_SCOPE_CHANGED_MESSAGE); return }
        if (saveTrip(data)) onClose()
      }}
    />
  )
}

export default function TripModalsHost({ state }: Props) {
  const {
    isDemo, canWrite, selectedTrip, schedules, currentTrip, display,
    scheduleModal, scheduleDetailTarget, closeScheduleDetail, editScheduleFromDetail,
    onScheduleSave, onScheduleDelete,
    editTripOpen,    setEditTripOpen, editTripScopeChanged, editTripSaveError, setEditTripSaveError, editTripGeneration,
    createTripOpen,  setCreateTripOpen, createTripGeneration,
    copyTripOpen,    setCopyTripOpen, copyTripSource, onCopyTrip,
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
          defaultDate={display ?? toLocalDateString(new Date())}
          // Trip date range — the picker disables days outside this
          // window and the form blocks save with an inline message if
          // an edit somehow lands a stored value out of range (e.g.
          // owner shrunk the trip after the schedule was created).
          tripStartDate={selectedTrip.startDate}
          tripEndDate={selectedTrip.endDate}
          schedules={schedules}
          defaultCountryCode={selectedTrip.defaultCountryCode}
          locationSearchEnabled={!isDemo}
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

      {/* Draft form: rendered per open (keyed by generation, NOT by the
          live trip id) so a trip switch underneath neither remounts it
          with another trip's data nor eats the draft. The sheet stays up
          until the user closes it; a save after the switch is refused in
          place (useScheduleModals stamps the scope at open). */}
      {editTripOpen && (
        <EditTripSheet
          key={editTripGeneration}
          initialTarget={selectedTrip}
          scheduleDates={schedules.map(s => s.date)}
          scopeChanged={editTripScopeChanged}
          saveError={editTripSaveError}
          saveTrip={saveTrip}
          onClose={() => setEditTripOpen(false)}
          onSaved={setEditTripSaveError}
        />
      )}

      {/* Per open instance (keyed by generation): the create write belongs
          to the instance that issued it, so a result landing after a
          dismiss-and-reopen cannot close or redirect the new sheet. */}
      {createTripOpen && (
        <CreateTripModal
          key={createTripGeneration}
          isOpen
          onClose={() => setCreateTripOpen(false)}
        />
      )}

      {!isDemo && copyTripSource && copyTripOpen && (
        // Conditionally rendered + keyed on the SNAPSHOT (not currentTrip)
        // so the post-confirm `setSelectedTripId(newTrip.id)` doesn't
        // re-key this modal mid-close. The snapshot was captured when
        // the modal opened — see useSchedulePageState's handleMenuAction
        // 'copy' branch. Busy state lives in the sheet (useAwaitedSave).
        <CopyTripModal
          key={copyTripSource.id}
          isOpen
          source={copyTripSource}
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
          {/* Keyed by trip id: these hold pending confirms (remove /
              transfer / leave) in internal state, which must never survive
              a trip switch — the open state itself already derives closed
              on switch (useScheduleModals), the key clears the internals. */}
          <Suspense fallback={null}>
            <InviteModal
              key={currentTrip.id}
              isOpen={inviteOpen}
              onClose={() => setInviteOpen(false)}
              trip={currentTrip}
            />
          </Suspense>
          <MembersModal
            key={currentTrip.id}
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
