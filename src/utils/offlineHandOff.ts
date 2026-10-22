// src/utils/offlineHandOff.ts
// Modal-wait writes (schedule / planning) go through the client Firestore
// SDK, whose write promise resolves only once the BACKEND acknowledges it.
// Without a connection that is "whenever the device reconnects", so a form
// tracking it would sit in 「儲存中…」 indefinitely. Two exits, both handing
// the write off the way an optimistic-close save does — close the form, keep
// the overlay row, and let the global MutationCache handler report a failure
// (the form's reportInForm is false once it is gone).
//
// 「已先儲存在此裝置」只有在 mutation 宣告 `networkMode: 'always'` 時才為真：
// TanStack 預設 `'online'` 會在離線時暫停 `mutationFn`，寫入只留在記憶體、
// 從未交給 Firestore SDK 的 IndexedDB 佇列。schedule / planning 的 hook 都
// 已宣告（見 useTripListMutation 的 networkMode 註解）；新的呼叫端必須比照，
// 否則這段文案就是謊言。
//   - known offline (navigator.onLine === false): hand off immediately
//   - "online" but unanswered (captive portal, dead Wi-Fi, a stalled
//     backend — navigator.onLine can't see those): hand off after a delay
import { toast } from '@/shared/toast'

export const OFFLINE_HAND_OFF_MESSAGE = '目前離線，已先儲存在此裝置，恢復連線後會自動同步'
export const SLOW_HAND_OFF_MESSAGE    = '連線較慢，仍在背景同步，完成後會自動更新'
/** Writes that cannot be handed off: trip create (a batch we must not
 *  double-create) and trip copy (needs server reads). The draft stays. */
export const OFFLINE_NEEDS_CONNECTION_MESSAGE = '目前離線，需要連線後才能建立或複製旅程'

/** How long a form waits for an unanswered write before handing it off. */
export const HAND_OFF_AFTER_MS = 10_000

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/**
 * Issue `write` for the form instance identified by `stillOpen`.
 *
 * Online, the promise is returned for the form to track; if it is still
 * unanswered after HAND_OFF_AFTER_MS the form is closed — but only while
 * `stillOpen()` holds, because `close` targets whatever form the page has
 * open now: once this instance is gone, a later form must not be closed
 * by its timer. Offline, the form is closed at once and nothing is
 * returned.
 */
export function trackUnlessOffline(
  write:     (reportInForm: () => boolean) => Promise<unknown>,
  stillOpen: () => boolean,
  close:     () => void,
): Promise<unknown> | undefined {
  if (isOffline()) {
    close()
    toast.info(OFFLINE_HAND_OFF_MESSAGE)
    // Failure is reported by the global handler; nothing is listening here.
    write(() => false).catch(() => {})
    return undefined
  }
  const pending = write(stillOpen)
  const timer = setTimeout(() => {
    if (!stillOpen()) return
    close()
    toast.info(SLOW_HAND_OFF_MESSAGE)
  }, HAND_OFF_AFTER_MS)
  // Settling either way ends the wait; the rejection itself is the form's
  // (or, once closed, the global handler's) to report.
  pending.then(() => clearTimeout(timer), () => clearTimeout(timer))
  return pending
}
