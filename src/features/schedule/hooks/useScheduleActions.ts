// src/features/schedule/hooks/useScheduleActions.ts
// Save / delete for a single schedule, plus the mutations behind them.
// Synchronous refusals (scope / epoch) go to the modal banner here; once a
// write is issued its promise is handed back and the FORM owns the outcome
// (useAwaitedSave): busy state, banner and closing belong to that open, so a
// late result can never close or mark another form opened since.
import { useCreateSchedule, useDeleteSchedule, useUpdateSchedule, nextScheduleOrder } from './useSchedules'
import { FORM_SCOPE_CHANGED_MESSAGE, type UseFormModalResult } from '@/hooks/useFormModal'
import type { CreateScheduleInput, Schedule } from '@/types'
import { buildScheduleUpdate } from '../services/scheduleService'
import { getClientWriteBlockReason } from '@/services/clientCompatibility'
import { toast } from '@/shared/toast'
import { simulateFailureMaybe } from '@/utils/devFailures'

export interface ScheduleActions {
  onScheduleSave:   (data: CreateScheduleInput, reportInForm: () => boolean) => void | Promise<unknown>
  onScheduleDelete: () => void | Promise<unknown>
}

export function useScheduleActions(opts: {
  isDemo:        boolean
  uid:           string | undefined
  tripId:        string | undefined
  /** The list the user is looking at, overlay included — a new schedule's
   *  per-day order has to account for rows still being written. */
  schedules:     Schedule[]
  scheduleModal: UseFormModalResult<Schedule>
  openSignIn:    () => void
}): ScheduleActions {
  const { isDemo, uid, tripId, schedules, scheduleModal, openSignIn } = opts

  // Not silent: `reportInForm` decides per write — the form reports while it
  // is still open, the global toast once it was dismissed.
  const createMut = useCreateSchedule(tripId ?? '')
  const updateMut = useUpdateSchedule(tripId ?? '')
  const deleteMut = useDeleteSchedule(tripId ?? '')

  // Demo save → close the form, pop the sign-in prompt. Cloud save →
  // Firestore write with an optimistic overlay.
  function onScheduleSave(data: CreateScheduleInput, reportInForm: () => boolean): void | Promise<unknown> {
    if (isDemo) { scheduleModal.close(); openSignIn(); return }
    if (!uid) { toast.error('正在準備登入，請稍候'); return }
    // The mutations bind to the LIVE trip id — a form opened on another trip
    // (background reselect after kick / remote delete) must not write here.
    if (scheduleModal.scopeChanged) { scheduleModal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    scheduleModal.clearError()
    const editTarget = scheduleModal.editTarget
    if (editTarget) {
      const updates = buildScheduleUpdate(editTarget, data)
      if (Object.keys(updates).length === 0) {
        scheduleModal.close()
        return
      }
      return simulateFailureMaybe().then(() =>
        updateMut.mutateAsync({ scheduleId: editTarget.id, updates, uid, reportInForm }))
    }
    // Both minted here: the id so the optimistic row and the stored doc
    // match, and the order so it is computed once from the list the user
    // is looking at (pending rows included) instead of twice.
    const create = {
      scheduleId: crypto.randomUUID(),
      input:      data,
      createdBy:  uid,
      order:      nextScheduleOrder(schedules, data.date),
      reportInForm,
    }
    return simulateFailureMaybe().then(() => createMut.mutateAsync(create))
  }

  function onScheduleDelete(): void | Promise<unknown> {
    if (!scheduleModal.editTarget) { scheduleModal.close(); return }
    if (isDemo) { scheduleModal.close(); openSignIn(); return }
    if (scheduleModal.scopeChanged) { scheduleModal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    // A sheet that was open when the epoch flipped still fires this, and the
    // global toast deliberately skips UpdateRequiredError — surface it in the
    // modal banner the same way save does.
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) { scheduleModal.setError(writeBlockReason); return }
    // Non-silent: the global toast reports a failure; the form closes itself
    // on success only if it is still the open one.
    return deleteMut.mutateAsync(scheduleModal.editTarget.id)
  }

  return {
    onScheduleSave,
    onScheduleDelete,
  }
}
