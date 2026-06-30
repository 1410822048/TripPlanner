// src/hooks/useForegroundPushMessages.ts
// While the app is in the foreground, FCM delivers via onMessage (the SW
// background handler does NOT fire). P1 contract: foreground = low-key
// in-app toast only, NEVER a system Notification (that's the SW's job when
// the page is backgrounded / closed).
//
// Gated on signed-in + permission granted so demo / signed-out / not-yet-
// opted-in sessions never pull the messaging SDK.
import { useEffect } from 'react'
import { getFirebaseMessaging } from '@/services/firebase'
import { useUid } from '@/hooks/useAuth'
import { toast } from '@/shared/toast'
import { PUSH_TOKEN_ENABLED_EVENT } from '@/features/account/services/pushTokenService'

export function useForegroundPushMessages(): void {
  const uid = useUid()
  useEffect(() => {
    if (!uid) return
    let cancelled = false
    let attaching = false
    let unsub: (() => void) | undefined

    async function attach() {
      if (cancelled || attaching || unsub) return
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      attaching = true
      try {
        const bundle = await getFirebaseMessaging()
        if (!bundle || cancelled || unsub) return
        unsub = bundle.onMessage(bundle.messaging, payload => {
          const targetUid = payload.data?.targetUid
          if (targetUid && targetUid !== uid) return
          const body = payload.data?.body
          if (body) toast.info(body)
        })
      } catch {
        // Non-fatal: a stale tab can miss a freshly deployed messaging chunk.
        // Keep the app usable and let the next foreground/opt-in event retry.
      } finally {
        attaching = false
      }
    }

    const requestAttach = () => { void attach() }
    requestAttach()
    window.addEventListener(PUSH_TOKEN_ENABLED_EVENT, requestAttach)
    document.addEventListener('visibilitychange', requestAttach)

    return () => {
      cancelled = true
      window.removeEventListener(PUSH_TOKEN_ENABLED_EVENT, requestAttach)
      document.removeEventListener('visibilitychange', requestAttach)
      unsub?.()
    }
  }, [uid])
}
