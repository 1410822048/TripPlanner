// src/features/account/services/pushTokenService.ts
// FCM token lifecycle (client side). Doc shape + transitions mirror the
// firestore.rules users/{uid}/pushTokens contract exactly:
//   - create: full doc, timestamps == serverTimestamp, disabledAt null,
//     no disabledReason (server-origin reasons can't be client-forged).
//   - refresh: bump updatedAt/lastSeenAt/appVersion only.
//   - user-disable: set disabledAt + a user-origin reason.
// tokenHash (sha256 of the raw token) is the doc id so the same browser/
// token pair upserts instead of accumulating stale docs.
import { getFirebase, getFirebaseMessaging } from '@/services/firebase'

export const PUSH_TOKEN_ENABLED_EVENT = 'tripmate:push-token-enabled'
const TOKEN_HASH_KEY = 'tripmate.push.tokenHash'

/** SHA-256 hex digest — stable id for an FCM token. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function readStoredPushTokenHash(): string | null {
  try { return localStorage.getItem(TOKEN_HASH_KEY) } catch { return null }
}

export function writeStoredPushTokenHash(hash: string | null): void {
  try {
    if (hash) localStorage.setItem(TOKEN_HASH_KEY, hash)
    else localStorage.removeItem(TOKEN_HASH_KEY)
  } catch { /* private mode: non-fatal */ }
}

function clearStoredPushTokenHashIfCurrent(hash: string): void {
  if (readStoredPushTokenHash() === hash) writeStoredPushTokenHash(null)
}

export function announcePushTokenEnabled(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new window.Event(PUSH_TOKEN_ENABLED_EVENT))
}

// Server-origin disable reasons. A doc carrying one is a tombstone for a
// dead FCM token — rules forbid the client re-enabling it (and should), so
// the only recovery is a freshly-minted token, not resurrecting this doc.
const SERVER_DISABLE_REASONS = ['fcm-unregistered', 'send-failed']

export interface SaveTokenInput {
  uid: string
  token: string
  swScope: string
  /**
   * Called when the existing doc for THIS exact token is server-disabled —
   * a dead FCM token the rules (correctly) refuse to re-enable. Must drop the
   * browser token and return a freshly minted one; saveToken then writes that
   * as a new doc. Absent → saveToken throws rather than attempt a doomed
   * re-enable (the stuck-toggle bug). Only the messaging-aware caller (the
   * hook) can mint, so it supplies this.
   */
  rotateToken?: () => Promise<string>
}

/**
 * Upsert the token doc. The rules split create vs refresh (different field
 * sets), so a blind setDoc/merge would violate one path — read first, then
 * branch. Returns the tokenHash so the caller can persist it for later
 * disable / state checks without re-deriving from the raw token.
 */
export async function saveToken({ uid, token, swScope, rotateToken }: SaveTokenInput): Promise<string> {
  const fb = await getFirebase()
  const tokenHash = await sha256Hex(token)
  const ref = fb.doc(fb.db, 'users', uid, 'pushTokens', tokenHash)
  const snap = await fb.getDoc(ref)
  if (snap.exists()) {
    const existing = snap.data()
    if (SERVER_DISABLE_REASONS.includes(existing.disabledReason)) {
      // Dead token. Re-enabling is rules-rejected and pointless — rotate to a
      // fresh one (new hash → create path). Inner call omits rotateToken, so
      // a still-dead fresh token surfaces an error instead of looping.
      if (!rotateToken) throw new Error('この通知トークンは無効化されています')
      return saveToken({ uid, token: await rotateToken(), swScope })
    }
    const patch: Record<string, unknown> = {
      updatedAt:  fb.serverTimestamp(),
      lastSeenAt: fb.serverTimestamp(),
      appVersion: __APP_VERSION__,
    }
    if (existing.disabledAt != null) {
      patch.disabledAt = null
      patch.disabledReason = fb.deleteField()
    }
    await fb.updateDoc(ref, patch)
  } else {
    await fb.setDoc(ref, {
      token,
      tokenHash,
      platform:   'web',
      provider:   'fcm',
      permission: 'granted',
      swScope,
      appVersion: __APP_VERSION__,
      createdAt:  fb.serverTimestamp(),
      updatedAt:  fb.serverTimestamp(),
      lastSeenAt: fb.serverTimestamp(),
      disabledAt: null,
    })
  }
  return tokenHash
}

/** Mark the token disabled. Client may only set the user-origin reasons;
 *  fcm-unregistered / send-failed are server-only (Functions admin SDK). */
async function disableToken(
  uid: string,
  tokenHash: string,
  reason: 'user-disabled' | 'permission-revoked',
): Promise<void> {
  const fb = await getFirebase()
  const ref = fb.doc(fb.db, 'users', uid, 'pushTokens', tokenHash)
  await fb.updateDoc(ref, {
    disabledAt:     fb.serverTimestamp(),
    disabledReason: reason,
    updatedAt:      fb.serverTimestamp(),
  })
}

export async function disableStoredPushToken(
  uid: string,
  reason: 'user-disabled' | 'permission-revoked' = 'user-disabled',
): Promise<void> {
  const hash = readStoredPushTokenHash()
  if (!hash) return
  await disableToken(uid, hash, reason)
  clearStoredPushTokenHashIfCurrent(hash)
}

async function deleteCurrentFcmToken(): Promise<boolean> {
  const bundle = await getFirebaseMessaging()
  return bundle ? bundle.deleteToken(bundle.messaging) : false
}

function canHaveCurrentFcmToken(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

export async function revokeStoredPushToken(
  uid: string,
  reason: 'user-disabled' | 'permission-revoked' = 'user-disabled',
): Promise<void> {
  const hash = readStoredPushTokenHash()
  if (!hash) {
    if (!canHaveCurrentFcmToken()) return
    try {
      await deleteCurrentFcmToken()
      return
    } catch (err) {
      throw new AggregateError([err], '通知トークンを解除できませんでした', { cause: err })
    }
  }

  const [serverDisable, browserDelete] = await Promise.allSettled([
    disableToken(uid, hash, reason),
    deleteCurrentFcmToken(),
  ])
  // Delivery is gated server-side on the token doc being enabled, so the
  // Firestore disable is the action that actually stops sends — gate success
  // on IT, not on either. A successful browser deleteToken must not mask a
  // failed server disable: that would leave the doc live and the (logged-out)
  // account still receiving on this device. Browser delete stays best-effort.
  if (serverDisable.status === 'fulfilled') {
    clearStoredPushTokenHashIfCurrent(hash)
    return
  }

  throw new AggregateError([
    serverDisable.reason,
    browserDelete.status === 'rejected'
      ? browserDelete.reason
      : new Error('browser token deleted but server disable did not complete'),
  ], '通知トークンを解除できませんでした')
}

/** Resolve whether this device's token doc is live, so the UI can show
 *  enabled/not-enabled without re-running getToken (no messaging SDK). */
export async function isTokenEnabled(
  uid: string,
  tokenHash: string,
): Promise<boolean> {
  const fb = await getFirebase()
  const snap = await fb.getDoc(fb.doc(fb.db, 'users', uid, 'pushTokens', tokenHash))
  return snap.exists() && snap.data().disabledAt == null
}
