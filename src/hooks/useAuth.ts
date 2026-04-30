// src/hooks/useAuth.ts
import { useCallback, useSyncExternalStore } from 'react'
import type { User } from 'firebase/auth'
import { getFirebaseAuth } from '@/services/firebase'

export type AuthState =
  | { status: 'loading' }
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

let currentState: AuthState = { status: 'loading' }
const listeners = new Set<() => void>()
let initPromise: Promise<void> | null = null

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
      const { auth, onAuthStateChanged, getRedirectResult } = await getFirebaseAuth()
      // AWAIT the redirect result BEFORE wiring onAuthStateChanged. On a
      // return from signInWithRedirect the URL carries the OAuth response;
      // getRedirectResult consumes those params and completes the sign-in.
      // If we register the observer first, its initial fire races the
      // pending redirect — the observer emits signed-out, then later signed-
      // in, and mobile users see a brief "still logged out" screen that
      // needs another tap to resolve. Serialising them eliminates that
      // flash: by the time the observer is registered, auth state is the
      // real post-redirect value.
      await getRedirectResult(auth).catch(() => { /* non-fatal — usually means no pending redirect */ })
      onAuthStateChanged(auth, u => {
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
 * for external singletons. The `enabled` parameter gates whether this call
 * should boot the auth observer; passing `false` (e.g. from a modal that
 * hasn't been opened yet) preserves the original "demo-only sessions never
 * pull the Auth SDK" optimisation.
 *
 * Sign-in uses signInWithPopup; falls back to signInWithRedirect when the
 * popup is blocked (iOS PWA home-screen, in-app browsers, some Android
 * embedded webviews).
 */
export function useAuth(enabled: boolean = true): UseAuthResult {
  // Boot the observer on first use. Idempotent — multiple calls share the
  // same promise. Kick off synchronously during render so subscribers hook
  // into the global state before any effect runs.
  if (enabled && !initPromise) void initAuth()

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const signInWithGoogle = useCallback(async () => {
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
  }, [])

  const doSignOut = useCallback(async () => {
    const { auth, signOut } = await getFirebaseAuth()
    await signOut(auth)
  }, [])

  return { state, signInWithGoogle, signOut: doSignOut }
}

/** Convenience: returns the uid once signed-in, `undefined` otherwise. */
export function useUid(enabled: boolean = true): string | undefined {
  const { state } = useAuth(enabled)
  return state.status === 'signed-in' ? state.user.uid : undefined
}
