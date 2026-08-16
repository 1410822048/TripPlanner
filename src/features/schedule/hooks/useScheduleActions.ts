// src/features/schedule/hooks/useScheduleActions.ts
// Save / delete for a single schedule, plus the mutations behind them.
// Errors surface in the modal's inline banner rather than a toast, which
// is why the mutations are created `silent`.
import { useCreateSchedule, useDeleteSchedule, useUpdateSchedule, nextScheduleOrder } from './useSchedules'
import { FORM_SCOPE_CHANGED_MESSAGE, type UseFormModalResult } from '@/hooks/useFormModal'
import type { CreateScheduleInput, Schedule } from '@/types'
import { buildScheduleUpdate } from '../services/scheduleService'
import { getClientWriteBlockReason } from '@/services/clientCompatibility'
import { toast } from '@/shared/toast'
import { simulateFailureMaybe } from '@/utils/devFailures'

export interface ScheduleActions {
  isSaving: boolean
  onScheduleSave:   (data: CreateScheduleInput) => Promise<void>
  onScheduleDelete: () => Promise<void>
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

  // silent — the modal surfaces errors via its inline banner, so a global
  // toast would double-notify.
  const createMut = useCreateSchedule(tripId ?? '', { silent: true })
  const updateMut = useUpdateSchedule(tripId ?? '', { silent: true })
  const deleteMut = useDeleteSchedule(tripId ?? '')

  // Demo save → close the form, pop the sign-in prompt. Cloud save →
  // Firestore write with an optimistic overlay.
  async function onScheduleSave(data: CreateScheduleInput) {
    if (isDemo) { scheduleModal.close(); openSignIn(); return }
    if (!uid) { toast.error('正在準備登入，請稍候'); return }
    // The mutations bind to the LIVE trip id — a form opened on another trip
    // (background reselect after kick / remote delete) must not write here.
    if (scheduleModal.scopeChanged) { scheduleModal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    scheduleModal.clearError()
    try {
      if (scheduleModal.editTarget) {
        const updates = buildScheduleUpdate(scheduleModal.editTarget, data)
        if (Object.keys(updates).length === 0) {
          scheduleModal.close()
          return
        }
        await simulateFailureMaybe()
        await updateMut.mutateAsync({ scheduleId: scheduleModal.editTarget.id, updates, uid })
      } else {
        await simulateFailureMaybe()
        // Both minted here: the id so the optimistic row and the stored doc
        // match, and the order so it is computed once from the list the
        // user is looking at (pending rows included) instead of twice.
        await createMut.mutateAsync({
          scheduleId: crypto.randomUUID(),
          input:      data,
          createdBy:  uid,
          order:      nextScheduleOrder(schedules, data.date),
        })
      }
      scheduleModal.close()
    } catch (err) {
      scheduleModal.setError(err instanceof Error ? err.message : '儲存失敗')
    }
  }

  async function onScheduleDelete() {
    if (!scheduleModal.editTarget) { scheduleModal.close(); return }
    if (isDemo) { scheduleModal.close(); openSignIn(); return }
    if (scheduleModal.scopeChanged) { scheduleModal.setError(FORM_SCOPE_CHANGED_MESSAGE); return }
    // A sheet that was open when the epoch flipped still fires this, and the
    // global toast deliberately skips UpdateRequiredError — surface it in the
    // modal banner the same way save does.
    const writeBlockReason = getClientWriteBlockReason()
    if (writeBlockReason) { scheduleModal.setError(writeBlockReason); return }
    try {
      await deleteMut.mutateAsync(scheduleModal.editTarget.id)
      scheduleModal.close()
    } catch { /* non-silent hook — the global toast covers non-epoch errors */ }
  }

  return {
    isSaving: createMut.isPending || updateMut.isPending,
    onScheduleSave,
    onScheduleDelete,
  }
}
