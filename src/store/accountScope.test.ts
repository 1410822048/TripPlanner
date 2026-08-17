import { beforeEach, describe, expect, it, vi } from 'vitest'

const TRIP_KEY   = 'tripmate-trip-store'
const VIEWED_KEY = 'tripmate-last-viewed'

/** Re-import the stores so `persist` re-hydrates from whatever the test
 *  seeded into localStorage — the hydration happens once at module load. */
async function loadStores() {
  const mod = await import('./tripStore')
  const viewed = await import('./lastViewedStore')
  const scope = await import('./accountScope')
  return {
    trip:   mod.useTripStore,
    viewed: viewed.useLastViewedStore,
    reconcileAccountScope: scope.reconcileAccountScope,
  }
}

function seed(key: string, state: Record<string, unknown>, version: number) {
  window.localStorage.setItem(key, JSON.stringify({ state, version }))
}

beforeEach(() => {
  window.localStorage.clear()
  // persist() hydrates once at module load, so the seeded blob is only read
  // if the module graph is rebuilt for each test.
  vi.resetModules()
})

describe('account-scoped persisted state', () => {
  it('claims unowned state on first sign-in without discarding it', async () => {
    const { trip, reconcileAccountScope } = await loadStores()
    trip.getState().setSelectedTripId('trip-1')

    reconcileAccountScope('uid-a')

    // Nothing to protect yet — the first account to sign in simply becomes
    // the owner, so a normal single-user session keeps working.
    expect(trip.getState().selectedTripId).toBe('trip-1')
    expect(trip.getState().ownerUid).toBe('uid-a')
  })

  it('resets everything when a DIFFERENT uid resolves (A→B, no signed-out fire)', async () => {
    const { trip, viewed, reconcileAccountScope } = await loadStores()
    reconcileAccountScope('uid-a')
    trip.getState().setSelectedTripId('trip-1')
    trip.getState().setTripOrder(['trip-1', 'trip-2'])
    viewed.getState().markViewed('trip-shared', 'expense', 5_000)

    reconcileAccountScope('uid-b')

    expect(trip.getState()).toMatchObject({
      selectedTripId: null,
      selectedTripAt: 0,
      recentTripIds:  [],
      tripOrder:      [],
      ownerUid:       'uid-b',
    })
    // The sharp one: both accounts can be members of trip-shared, so an
    // inherited watermark would hide activity uid-b has never seen.
    expect(viewed.getState().viewed).toEqual({})
    expect(viewed.getState().ownerUid).toBe('uid-b')
  })

  it('keeps state for the SAME uid, so a repeat resolution is a no-op', async () => {
    const { trip, viewed, reconcileAccountScope } = await loadStores()
    reconcileAccountScope('uid-a')
    trip.getState().setTripOrder(['trip-1'])
    viewed.getState().markViewed('trip-1', 'wish', 9_000)

    // The observer fires on every auth event; re-claiming must not wipe.
    reconcileAccountScope('uid-a')
    reconcileAccountScope('uid-a')

    expect(trip.getState().tripOrder).toEqual(['trip-1'])
    expect(viewed.getState().viewed).toEqual({ 'trip-1': { wish: 9_000 } })
  })

  it('keeps state through sign-out so the same person resumes', async () => {
    const { trip, reconcileAccountScope } = await loadStores()
    reconcileAccountScope('uid-a')
    trip.getState().setTripOrder(['trip-1'])

    reconcileAccountScope(null)

    expect(trip.getState().tripOrder).toEqual(['trip-1'])
    expect(trip.getState().ownerUid).toBe('uid-a')
  })
})

describe('cold start under another account', () => {
  it('discards hydrated state belonging to a different uid', async () => {
    // The gap a sign-out hook cannot cover: the app is launched fresh, the
    // previous session's blob hydrates at module load, and the account that
    // resolves is somebody else.
    seed(TRIP_KEY, {
      selectedTripId: 'trip-a', selectedTripAt: 111,
      recentTripIds: ['trip-a'], tripOrder: ['trip-a'], ownerUid: 'uid-a',
    }, 2)
    seed(VIEWED_KEY, { viewed: { 'trip-shared': { expense: 5_000 } }, ownerUid: 'uid-a' }, 2)

    const { trip, viewed, reconcileAccountScope } = await loadStores()
    // Precondition: the blob really did hydrate, or this proves nothing.
    expect(trip.getState().selectedTripId).toBe('trip-a')

    reconcileAccountScope('uid-b')

    expect(trip.getState().selectedTripId).toBeNull()
    expect(trip.getState().tripOrder).toEqual([])
    expect(viewed.getState().viewed).toEqual({})
  })

  it('resumes hydrated state for the same uid', async () => {
    // Positive control: without it the test above would pass even if
    // hydration were broken and every launch started empty.
    seed(TRIP_KEY, {
      selectedTripId: 'trip-a', selectedTripAt: 111,
      recentTripIds: ['trip-a'], tripOrder: ['trip-a'], ownerUid: 'uid-a',
    }, 2)

    const { trip, reconcileAccountScope } = await loadStores()
    reconcileAccountScope('uid-a')

    expect(trip.getState().selectedTripId).toBe('trip-a')
    expect(trip.getState().tripOrder).toEqual(['trip-a'])
  })
})

// The reconcile above is only as good as WHERE it is wired. useAuth already
// has a uid-change guard that deliberately skips the initial restore (so a
// normal boot doesn't nuke caches) — putting the reconcile inside it would
// silently lose exactly the cold-start case. This drives the real observer.
describe('auth wiring', () => {
  it('reconciles on the INITIAL auth fire, not just on a transition', async () => {
    seed(TRIP_KEY, {
      selectedTripId: 'trip-a', selectedTripAt: 111,
      recentTripIds: ['trip-a'], tripOrder: ['trip-a'], ownerUid: 'uid-a',
    }, 2)

    let emit: ((user: { uid: string } | null) => void) | undefined
    vi.doMock('@/services/firebase', () => ({
      getFirebaseAuth: async () => ({
        auth: { authStateReady: async () => {}, currentUser: null },
        onAuthStateChanged: (_auth: unknown, cb: (u: { uid: string } | null) => void) => {
          emit = cb
          return () => {}
        },
        getRedirectResult: async () => null,
      }),
    }))

    const { renderHook, waitFor } = await import('@testing-library/react')
    const { useAuth } = await import('../hooks/useAuth')
    const { useTripStore } = await import('./tripStore')
    // Precondition: the previous account's blob really did hydrate.
    expect(useTripStore.getState().selectedTripId).toBe('trip-a')

    renderHook(() => useAuth(true))
    await waitFor(() => expect(emit).toBeDefined())

    // FIRST fire of the observer, carrying a different account — the exact
    // shape of launching the app cold under uid-b.
    emit!({ uid: 'uid-b' })

    expect(useTripStore.getState().selectedTripId).toBeNull()
    expect(useTripStore.getState().tripOrder).toEqual([])
    expect(useTripStore.getState().ownerUid).toBe('uid-b')
    vi.doUnmock('@/services/firebase')
  })
})

describe('v1 → v2 migration', () => {
  it('discards a pre-ownerUid blob rather than letting the next signer claim it', async () => {
    // A v1 blob has unknown provenance. Merge-defaulting ownerUid to null
    // would hand it to whoever signs in next — precisely the leak the field
    // exists to stop.
    seed(TRIP_KEY, {
      selectedTripId: 'trip-a', selectedTripAt: 111,
      recentTripIds: ['trip-a'], tripOrder: ['trip-a', 'trip-b'],
    }, 1)
    seed(VIEWED_KEY, { viewed: { 'trip-shared': { expense: 5_000 } } }, 1)

    const { trip, viewed } = await loadStores()

    expect(trip.getState()).toMatchObject({
      selectedTripId: null, recentTripIds: [], tripOrder: [], ownerUid: null,
    })
    expect(viewed.getState().viewed).toEqual({})
    expect(viewed.getState().ownerUid).toBeNull()
  })
})
