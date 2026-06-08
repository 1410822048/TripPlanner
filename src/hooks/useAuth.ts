// src/hooks/useAuth.ts
import { useSyncExternalStore } from 'react'
import type { User } from 'firebase/auth'
import { getFirebaseAuth } from '@/services/firebase'
import { clearAttachmentUrlCache } from './useAttachmentUrl'
import { markPerf } from '@/utils/perf'

export type AuthState =
  | { status: 'loading'; wasSignedIn: boolean }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: User }
  | { status: 'error'; error: Error }

export interface UseAuthResult {
  state: AuthState
  signInWithGoogle: () => Promise<void>
  signOut:          () => Promise<void>
}

// ─── Module-level singleton ───────────────────────────────────────
// The auth observer lives once per page load; every useAuth() consumer reads
// from the same `currentState`. A previous implementation used `useState` +
// `useEffect` per component, which produced set-state-in-effect lint errors
// and subtle cascade re-renders. React's built-in `useSyncExternalStore`
// solves the same problem more cleanly: consumers subscribe once, snapshot
// the state synchronously, and React handles tear-off + tearing-safety
// across concurrent renders.

// Synchronous "was the user signed in when they last closed the app?"
// hint. Firebase Auth's own persistence lives in IndexedDB (async), so
// during the initial-paint window we have no synchronous way to know
// the real answer — the observer hasn't fired yet. We stash a tiny
// localStorage marker on every onAuthStateChanged transition so the
// next boot can answer the question without awaiting Firebase.
//
// Callers (SchedulePage's preview-first UX) use this to tell apart
// "auth loading, expect a real user" (show spinner) from "auth loading,
// genuinely new visitor" (show demo). Wrong answers degrade gracefully:
// - Hint=true but actually signed-out → brief spinner → falls to demo.
// - Hint=false but actually signed-in → brief demo flash, same as
//   the pre-hint behaviour.
const AUTH_HINT_KEY = 'tripmate.auth.hint'

export function readAuthHint(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(AUTH_HINT_KEY) === '1' }
  catch { return false }
}
function writeAuthHint(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(AUTH_HINT_KEY, '1')
    else          localStorage.removeItem(AUTH_HINT_KEY)
  } catch { /* private mode / SSR — non-fatal */ }
}

let currentState: AuthState = { status: 'loading', wasSignedIn: readAuthHint() }
const listeners = new Set<() => void>()
let initPromise: Promise<void> | null = null
// Track the last observed uid so an account switch / sign-out purges the
// attachment objectURL cache (private image bytes must not survive across
// users on a shared device). `null` = signed-out / never-signed-in.
let lastObservedUid: string | null = null

function setGlobal(next: AuthState): void {
  currentState = next
  for (const fn of listeners) fn()
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => { listeners.delete(onStoreChange) }
}

function getSnapshot(): AuthState {
  return currentState
}

/**
 * Boot the auth observer exactly once. Safe to call from anywhere; subsequent
 * calls return the same promise. Call from app entry so the Auth SDK chunk
 * and onAuthStateChanged subscription are warm before any route renders —
 * the first sign-in tap then skips a ~200ms bundle download.
 */
export function initAuth(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      markPerf('auth-sdk-loaded')
      const { auth, onAuthStateChanged } = await getFirebaseAuth()
      markPerf('auth-bundle-resolved')
      // Wait for the initial auth state to be known before wiring the
      // observer. Firebase v9+ exposes `authStateReady()` for exactly
      // this — documented as "less invasive than getRedirectResult"
      // because it skips the redirect-result-specific code paths when
      // there's nothing to process, while still awaiting the same
      // persistence init that the SDK needs internally.
      //
      // Why await (not parallelise): one prior attempt to wire the
      // observer concurrently saw it fire signed-out before Firebase
      // had finished loading the cached user from IndexedDB. The
      // observer's initial fire is coupled to the same init that
      // authStateReady resolves with — serialising keeps the
      // signed-in restore correct.
      //
      // Redirect-return UX (rare): Firebase Auth processes pending
      // redirect URLs as part of init itself; we don't need to call
      // getRedirectResult to trigger it. If a redirect sign-in failed,
      // authStateReady simply resolves with no user → page shows
      // signed-out, same as current behaviour with the catch-and-
      // ignore on getRedirectResult.
      await auth.authStateReady()
      markPerf('auth-state-ready')
      onAuthStateChanged(auth, u => {
        writeAuthHint(!!u)
        markPerf(u ? 'auth-state-signed-in' : 'auth-state-signed-out')
        // Sign-out or account switch → drop the previous user's cached
        // attachment objectURLs. Covers the explicit signOut() path too
        // (it fires this observer with u=null). Skips the initial restore
        // (lastObservedUid null → same uid, no-op).
        const nextUid = u?.uid ?? null
        if (nextUid !== lastObservedUid) {
          if (lastObservedUid !== null) clearAttachmentUrlCache()
          lastObservedUid = nextUid
        }
        setGlobal(u ? { status: 'signed-in', user: u } : { status: 'signed-out' })
      })
    } catch (e) {
      setGlobal({ status: 'error', error: e instanceof Error ? e : new Error(String(e)) })
    }
  })()
  return initPromise
}

/**
 * Subscribe to auth state via `useSyncExternalStore` — React's canonical API
 * for external singletons.
 *
 * The `enabled` parameter gates whether this call boots the auth observer.
 * When omitted, it defaults to the localStorage auth hint:
 *   - hint=true  (returning user, previously signed in) → trigger SDK load
 *   - hint=false (never signed in) → defer until a caller passes `true`
 *     explicitly (typically SignInPromptModal opening)
 * This keeps the ~45 KB gz Auth SDK chunk off the cold-start path for
 * demo-only sessions. Callers that always need auth (sign-out screen,
 * invite-redeem flow) pass `true` explicitly to override the hint.
 *
 * Sign-in uses signInWithPopup; falls back to signInWithRedirect when the
 * popup is blocked (iOS PWA home-screen, in-app browsers, some Android
 * embedded webviews).
 */
export function useAuth(enabled?: boolean): UseAuthResult {
  // Boot the observer on first use. Idempotent — multiple calls share the
  // same promise. Kick off synchronously during render so subscribers hook
  // into the global state before any effect runs.
  const effectiveEnabled = enabled ?? readAuthHint()
  if (effectiveEnabled && !initPromise) void initAuth()

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  // Compiler memoises these — manual useCallback would be redundant.
  const signInWithGoogle = async () => {
    const { auth, GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await getFirebaseAuth()
    const provider = new GoogleAuthProvider()
    try {
      await signInWithPopup(auth, provider)
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code
      // Popup blocked / unsupported → redirect. Page navigates away; result
      // is picked up by getRedirectResult on return.
      if (code === 'auth/popup-blocked'
        || code === 'auth/operation-not-supported-in-this-environment'
        || code === 'auth/cancelled-popup-request') {
        await signInWithRedirect(auth, provider)
        return
      }
      throw e
    }
  }

  const doSignOut = async () => {
    const { auth, signOut } = await getFirebaseAuth()
    await signOut(auth)
  }

  return { state, signInWithGoogle, signOut: doSignOut }
}

/** Convenience: returns the uid once signed-in, `undefined` otherwise.
 *  Same hint-based default as `useAuth` — see its docstring. */
export function useUid(enabled?: boolean): string | undefined {
  const { state } = useAuth(enabled)
  return state.status === 'signed-in' ? state.user.uid : undefined
}
