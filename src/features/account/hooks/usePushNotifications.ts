// src/features/account/hooks/usePushNotifications.ts
// State machine behind the Account notification toggle. Owns support
// detection, permission, and the enabled/blocked/... subscription state.
//
// useEffect+useState is the right tool here (not React-Compiler-memoised
// derivations): support + permission are EXTERNAL browser state that has
// to be probed asynchronously and re-probed on tab focus — the same
// "subscribe to an external resource" exception useBlobUrl carves out.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getFirebaseMessaging } from '@/services/firebase'
import {
  disableStoredPushToken,
  isTokenEnabled,
  readStoredPushTokenHash,
  saveToken,
  writeStoredPushTokenHash,
} from '../services/pushTokenService'

export type PushSupport = 'checking' | 'supported' | 'unsupported' | 'ios-not-installed'
export type PushPermission = 'default' | 'granted' | 'denied' | 'unknown'
export type PushState =
  | 'signed-out' | 'unsupported' | 'blocked' | 'not-enabled'
  | 'enabling' | 'enabled' | 'disabling' | 'error'

export interface UsePushNotificationsResult {
  support: PushSupport
  state: PushState
  error: string | null
  enable: () => Promise<void>
  disable: () => Promise<void>
}

const VAPID_KEY = (import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined)?.trim()

function isIOS(): boolean {
  const ua = navigator.userAgent
  // iPadOS 13+ reports as MacIntel; maxTouchPoints disambiguates.
  return /iphone|ipad|ipod/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as { standalone?: boolean }).standalone === true
}

function detectSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  if (!VAPID_KEY) return 'unsupported'
  // iOS only delivers Web Push to Home-Screen-installed PWAs — surface the
  // install hint rather than a flat "unsupported" (covers <16.4 Safari too,
  // which lacks PushManager entirely).
  if (isIOS() && !isStandalone()) return 'ios-not-installed'
  const base = 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
  return base ? 'supported' : 'unsupported'
}

function readPermission(): PushPermission {
  if (typeof Notification === 'undefined') return 'unknown'
  return Notification.permission as PushPermission
}

function enableErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : ''
  if (/Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(message)) {
    return '請更新 App 後再重新啟用通知'
  }
  return message || '無法啟用通知'
}

export function usePushNotifications(uid: string | undefined): UsePushNotificationsResult {
  const [support, setSupport] = useState<PushSupport>('checking')
  const [state, setState] = useState<PushState>('signed-out')
  const [error, setError] = useState<string | null>(null)
  // UI busy state blocks double-clicks; this blocks older awaited work from
  // writing state after a newer enable/disable action has won.
  const actionSeq = useRef(0)
  const actionInFlight = useRef(false)
  const activeUid = useRef<string | undefined>(uid)

  useLayoutEffect(() => {
    activeUid.current = uid
    return () => {
      activeUid.current = undefined
      actionSeq.current += 1
      actionInFlight.current = false
    }
  }, [uid])

  function beginAction(actionUid: string): (() => boolean) | null {
    if (actionInFlight.current || activeUid.current !== actionUid) return null
    const seq = ++actionSeq.current
    actionInFlight.current = true
    return () => seq === actionSeq.current && activeUid.current === actionUid
  }

  // Resolve initial state + re-resolve on tab focus (catches OS-level
  // permission revocation while the app was backgrounded).
  useEffect(() => {
    let cancelled = false
    function canApply(seq: number) {
      return !cancelled && !actionInFlight.current && seq === actionSeq.current
    }
    async function resolve() {
      if (actionInFlight.current) return
      const seq = actionSeq.current
      const sup = detectSupport()
      const perm = readPermission()
      if (!canApply(seq)) return
      setSupport(sup)
      if (!uid) { setState('signed-out'); return }
      if (sup !== 'supported') { setState('unsupported'); return }
      if (perm === 'denied') {
        // Believed-enabled but the OS revoked → flip the stored token to
        // permission-revoked so delivery stops targeting a dead grant.
        // The helper clears the local retry hint only after the server write
        // succeeds; failures retry on the next visibility/resolve pass.
        void disableStoredPushToken(uid, 'permission-revoked').catch(() => {})
        setState('blocked'); return
      }
      if (perm !== 'granted') { setState('not-enabled'); return }
      const hash = readStoredPushTokenHash()
      if (!hash) { setState('not-enabled'); return }
      try {
        const enabled = await isTokenEnabled(uid, hash)
        if (!canApply(seq)) return
        if (enabled) { setState('enabled') }
        else { writeStoredPushTokenHash(null); setState('not-enabled') }
      } catch {
        if (canApply(seq)) setState('not-enabled')
      }
    }
    void resolve()
    document.addEventListener('visibilitychange', resolve)
    return () => { cancelled = true; document.removeEventListener('visibilitychange', resolve) }
  }, [uid])

  async function enable(): Promise<void> {
    if (!uid || support !== 'supported' || !VAPID_KEY) return
    const actionUid = uid
    const canApply = beginAction(actionUid)
    if (!canApply) return
    setState('enabling'); setError(null)
    try {
      // requestPermission MUST run inside the user gesture (button onClick).
      const perm = await Notification.requestPermission()
      if (!canApply()) return
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'blocked' : 'not-enabled')
        return
      }
      const bundle = await getFirebaseMessaging()
      if (!canApply()) return
      if (!bundle) {
        setSupport('unsupported'); setState('unsupported')
        return
      }
      // Reuse the existing PWA service worker — do NOT let FCM register a
      // second root-scope SW (it would fight the Workbox one).
      const registration = await navigator.serviceWorker.ready
      if (!canApply()) return
      const token = await bundle.getToken(bundle.messaging, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: registration,
      })
      if (!canApply()) return
      if (!token) {
        setState('not-enabled'); setError('無法取得通知權杖')
        return
      }
      const hash = await saveToken({
        uid: actionUid,
        token,
        swScope: registration.scope,
        // Recovery for a server-disabled (dead) token doc: drop the browser
        // token so FCM mints a different one, then re-getToken. saveToken
        // writes the fresh token as a new doc.
        rotateToken: async () => {
          await bundle.deleteToken(bundle.messaging)
          const fresh = await bundle.getToken(bundle.messaging, {
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration,
          })
          if (!fresh) throw new Error('無法取得通知權杖')
          return fresh
        },
      })
      if (!canApply()) return
      writeStoredPushTokenHash(hash)
      setState('enabled')
    } catch (e) {
      if (canApply()) {
        setError(enableErrorMessage(e))
        setState('error')
      }
    } finally {
      if (canApply()) actionInFlight.current = false
    }
  }

  async function disable(): Promise<void> {
    if (!uid) return
    const actionUid = uid
    const canApply = beginAction(actionUid)
    if (!canApply) return
    setState('disabling'); setError(null)
    try {
      if (!canApply()) return
      await disableStoredPushToken(actionUid)
      if (!canApply()) return
      setState('not-enabled')
    } catch (e) {
      if (canApply()) {
        setError(e instanceof Error ? e.message : '無法關閉通知')
        setState('error')
      }
    } finally {
      if (canApply()) actionInFlight.current = false
    }
  }

  return { support, state, error, enable, disable }
}
