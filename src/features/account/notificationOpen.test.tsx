import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { To } from 'react-router-dom'
import type { AuthState } from '@/hooks/useAuth'
import { registerOpenDraftModal } from '@/hooks/draftModalRegistry'
import {
  NOTIFICATION_OPEN_MESSAGE,
  NOTIFICATION_PAYLOAD_REQUEST,
  NOTIFICATION_PAYLOAD_RESPONSE,
  notifyLaunchUrl,
} from '@/services/notificationOpenProtocol'

const mocks = vi.hoisted(() => ({
  auth:              { status: 'loading', wasSignedIn: true } as unknown,
  trips:             { status: 'pending', data: undefined } as { status: string; data: { id: string }[] | undefined },
  useAuth:           vi.fn(),
  useMyTrips:        vi.fn(),
  setSelectedTripId: vi.fn(),
  toastInfo:         vi.fn(),
  toastError:        vi.fn(),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: (enabled?: boolean) => {
    mocks.useAuth(enabled)
    return { state: mocks.auth }
  },
}))
vi.mock('@/features/trips/hooks/useTrips', () => ({
  useMyTrips: (key: string | undefined) => {
    mocks.useMyTrips(key)
    return key ? mocks.trips : { status: 'pending', data: undefined }
  },
}))
vi.mock('@/store/tripStore', () => ({
  useTripStore: { getState: () => ({ setSelectedTripId: mocks.setSelectedTripId }) },
}))
vi.mock('@/shared/toast', () => ({
  toast: { info: mocks.toastInfo, error: mocks.toastError },
}))

import {
  NOTIFICATION_OPEN_COPY,
  __resetNotificationOpenForTests,
  decideNotificationOpen,
  enqueueNotificationOpen,
  listenForNotificationOpen,
  useNotificationOpenHandler,
  type NotificationOpenIntent,
  type NotificationOpenRouter,
  type ServiceWorkerBridge,
} from './notificationOpen'

const UID_A = 'uid-a'
const UID_B = 'uid-b'
const NONCE = '0b7c2f1e-5a3d-4c8e-9f10-2a3b4c5d6e7f'

const tripIntent: NotificationOpenIntent = { scope: 'trip', route: '/expense', tripId: 'trip-1', targetUid: UID_A }
const accountIntent: NotificationOpenIntent = { scope: 'account', route: '/account', tripId: 'trip-gone', targetUid: UID_A }

function signedIn(uid: string): AuthState {
  return { status: 'signed-in', user: { uid } } as AuthState
}

function fakeRouter(path = '/schedule', search = '') {
  const router: NotificationOpenRouter & { navigate: ReturnType<typeof vi.fn> } = {
    state:    { location: { pathname: path, search, hash: '' } },
    navigate: vi.fn((to: To) => {
      if (typeof to === 'string') {
        router.state.location = { pathname: to, search: '', hash: '' }
      } else {
        router.state.location = {
          pathname: to.pathname ?? router.state.location.pathname,
          search:   to.search ?? '',
          hash:     to.hash ?? '',
        }
      }
    }),
  }
  return router
}

/** navigator.serviceWorker 替身；controller 依 nonce 回覆 SW 暫存的 payload。 */
function fakeBridge(stored: Record<string, unknown> = {}) {
  const target = new EventTarget()
  const controller = {
    postMessage: vi.fn((message: unknown, transfer: Transferable[]) => {
      const msg = message as { type: string; nonce: string }
      const port = transfer[0] as MessagePort
      if (msg.type !== NOTIFICATION_PAYLOAD_REQUEST) return
      const payload = stored[msg.nonce] ?? null
      delete stored[msg.nonce]
      port.postMessage({ type: NOTIFICATION_PAYLOAD_RESPONSE, payload })
    }),
  }
  const bridge: ServiceWorkerBridge & { dispatch: (data: unknown) => void; startMessages: ReturnType<typeof vi.fn<() => void>> } = {
    controller,
    ready:               Promise.resolve({ active: controller }),
    addEventListener:    (type, listener) => target.addEventListener(type, listener as EventListener),
    startMessages:       vi.fn<() => void>(),
    dispatch:            data => target.dispatchEvent(new MessageEvent('message', { data })),
  }
  return { bridge, controller }
}

function routeNavigations(router: ReturnType<typeof fakeRouter>): unknown[] {
  return router.navigate.mock.calls.filter(([to]) => typeof to === 'string').map(([to]) => to)
}

let releaseDraft: (() => void) | null = null

beforeEach(() => {
  __resetNotificationOpenForTests()
  mocks.auth = { status: 'loading', wasSignedIn: true }
  mocks.trips = { status: 'pending', data: undefined }
  vi.clearAllMocks()
})

afterEach(() => {
  releaseDraft?.()
  releaseDraft = null
})

describe('decideNotificationOpen', () => {
  const ready = { status: 'ready' as const, tripIds: ['trip-1'] }
  const me = { status: 'signed-in' as const, uid: UID_A }

  it('waits for auth, then for the trip list', () => {
    expect(decideNotificationOpen({ intent: tripIntent, auth: { status: 'loading' }, trips: ready, draftOpen: false }))
      .toEqual({ kind: 'wait' })
    expect(decideNotificationOpen({ intent: tripIntent, auth: me, trips: { status: 'pending' }, draftOpen: false }))
      .toEqual({ kind: 'wait' })
  })

  it('navigates a member to the trip route', () => {
    expect(decideNotificationOpen({ intent: tripIntent, auth: me, trips: ready, draftOpen: false }))
      .toEqual({ kind: 'navigate', route: '/expense', tripId: 'trip-1' })
  })

  it('rejects before reading trips when the recipient is someone else / unknown / signed out', () => {
    const pending = { status: 'pending' as const }
    expect(decideNotificationOpen({ intent: tripIntent, auth: { status: 'signed-in', uid: UID_B }, trips: pending, draftOpen: false }))
      .toMatchObject({ kind: 'reject', message: NOTIFICATION_OPEN_COPY.otherAccount })
    expect(decideNotificationOpen({ intent: { ...tripIntent, targetUid: undefined }, auth: me, trips: pending, draftOpen: false }))
      .toMatchObject({ kind: 'reject', message: NOTIFICATION_OPEN_COPY.unknownRecipient })
    expect(decideNotificationOpen({ intent: tripIntent, auth: { status: 'signed-out' }, trips: pending, draftOpen: false }))
      .toMatchObject({ kind: 'reject', message: NOTIFICATION_OPEN_COPY.signedOut })
  })

  it('routes account scope to /account without membership or trip switch', () => {
    expect(decideNotificationOpen({ intent: accountIntent, auth: me, trips: { status: 'pending' }, draftOpen: false }))
      .toEqual({ kind: 'navigate', route: '/account', tripId: null })
  })

  it('rejects non-members, trip-list errors and open drafts', () => {
    expect(decideNotificationOpen({ intent: tripIntent, auth: me, trips: { status: 'ready', tripIds: ['other'] }, draftOpen: false }))
      .toMatchObject({ kind: 'reject', message: NOTIFICATION_OPEN_COPY.notMember })
    expect(decideNotificationOpen({ intent: tripIntent, auth: me, trips: { status: 'error' }, draftOpen: false }))
      .toMatchObject({ kind: 'reject', tone: 'error' })
    expect(decideNotificationOpen({ intent: tripIntent, auth: me, trips: ready, draftOpen: true }))
      .toMatchObject({ kind: 'reject', message: NOTIFICATION_OPEN_COPY.draftOpen })
    expect(decideNotificationOpen({ intent: accountIntent, auth: me, trips: ready, draftOpen: true }))
      .toMatchObject({ kind: 'reject', message: NOTIFICATION_OPEN_COPY.draftOpen })
  })
})

describe('enqueueNotificationOpen', () => {
  it('ignores routes outside the whitelist and malformed scope pairs', () => {
    expect(enqueueNotificationOpen({ ...tripIntent, route: '/admin' })).toBe(false)
    expect(enqueueNotificationOpen({ ...tripIntent, route: 'https://evil.test/' })).toBe(false)
    expect(enqueueNotificationOpen({ ...accountIntent, route: '/expense' })).toBe(false)
    expect(enqueueNotificationOpen(tripIntent)).toBe(true)
  })
})

describe('listenForNotificationOpen', () => {
  it('captures a message delivered before React mounts, and attaches only once', () => {
    const { bridge } = fakeBridge()
    const add = vi.spyOn(bridge, 'addEventListener')
    listenForNotificationOpen(bridge)
    listenForNotificationOpen(bridge)
    expect(add).toHaveBeenCalledTimes(1)
    expect(bridge.startMessages).toHaveBeenCalledTimes(1)

    // 載入中視窗：訊息比任何 render / effect 先到。
    bridge.dispatch({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent })
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    const router = fakeRouter()
    renderHook(() => useNotificationOpenHandler(router, bridge))
    expect(add).toHaveBeenCalledTimes(1)
    expect(mocks.setSelectedTripId).toHaveBeenCalledWith('trip-1')
    expect(routeNavigations(router)).toEqual(['/expense'])
  })
})

describe('useNotificationOpenHandler — already-open window (postMessage)', () => {
  function mount(router = fakeRouter()) {
    const { bridge } = fakeBridge()
    const hook = renderHook(() => useNotificationOpenHandler(router, bridge))
    const post = (data: unknown) => act(() => { bridge.dispatch(data) })
    return { router, bridge, hook, post }
  }

  it('navigates a valid trip notification only after auth and trips are ready', () => {
    const { router, bridge, hook, post } = mount()
    expect(bridge.startMessages).toHaveBeenCalled()
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent })
    // 有待處理點擊時強制啟動 auth。
    expect(mocks.useAuth).toHaveBeenLastCalledWith(true)
    expect(router.navigate).not.toHaveBeenCalled()

    mocks.auth = signedIn(UID_A)
    hook.rerender()
    expect(mocks.useMyTrips).toHaveBeenLastCalledWith(UID_A)
    expect(router.navigate).not.toHaveBeenCalled()

    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    hook.rerender()
    expect(mocks.setSelectedTripId).toHaveBeenCalledWith('trip-1')
    expect(routeNavigations(router)).toEqual(['/expense'])

    // 一次點擊只執行一次。
    hook.rerender()
    expect(router.navigate).toHaveBeenCalledTimes(1)
  })

  it("A's notification clicked while B is signed in: no navigation, no trip switch, no trip read", () => {
    const { router, hook, post } = mount()
    mocks.auth = signedIn(UID_B)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent })
    hook.rerender()
    expect(router.navigate).not.toHaveBeenCalled()
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
    expect(mocks.useMyTrips).not.toHaveBeenCalledWith(UID_B)
    expect(mocks.toastInfo).toHaveBeenCalledWith(NOTIFICATION_OPEN_COPY.otherAccount)
  })

  it('missing targetUid: no navigation', () => {
    const { router, post } = mount()
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent, targetUid: undefined })
    expect(router.navigate).not.toHaveBeenCalled()
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledWith(NOTIFICATION_OPEN_COPY.unknownRecipient)
  })

  it('account scope goes to /account without membership or trip switch', () => {
    const { router, post } = mount()
    mocks.auth = signedIn(UID_A)
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...accountIntent })
    expect(routeNavigations(router)).toEqual(['/account'])
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
    expect(mocks.useMyTrips).not.toHaveBeenCalledWith(UID_A)
  })

  it('non-member: toast and stay', () => {
    const { router, post } = mount()
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'another-trip' }] }
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent })
    expect(router.navigate).not.toHaveBeenCalled()
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledWith(NOTIFICATION_OPEN_COPY.notMember)
  })

  it('draft modal open: no navigation (trip and account scope)', () => {
    const { router, post } = mount()
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    releaseDraft = registerOpenDraftModal()
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent })
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...accountIntent })
    expect(router.navigate).not.toHaveBeenCalled()
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
    expect(mocks.toastInfo).toHaveBeenCalledTimes(2)
    expect(mocks.toastInfo).toHaveBeenCalledWith(NOTIFICATION_OPEN_COPY.draftOpen)
  })

  it('invalid route / foreign message types are ignored', () => {
    const { router, post } = mount()
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent, route: '/admin' })
    post({ type: 'SOMETHING_ELSE', ...tripIntent })
    expect(router.navigate).not.toHaveBeenCalled()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
    expect(mocks.useAuth).not.toHaveBeenCalledWith(true)
  })

  it('skips the navigation when already on the target route', () => {
    const { router, post } = mount(fakeRouter('/expense'))
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    post({ type: NOTIFICATION_OPEN_MESSAGE, ...tripIntent })
    expect(mocks.setSelectedTripId).toHaveBeenCalledWith('trip-1')
    expect(router.navigate).not.toHaveBeenCalled()
  })
})

describe('useNotificationOpenHandler — cold start (?notify=<nonce>)', () => {
  function launch(stored: Record<string, unknown>) {
    const search = new URL(notifyLaunchUrl(NONCE), 'https://tripmate.test').search
    const router = fakeRouter('/schedule', search)
    const { bridge, controller } = fakeBridge(stored)
    const hook = renderHook(() => useNotificationOpenHandler(router, bridge))
    return { router, controller, hook }
  }

  const stripped = (router: ReturnType<typeof fakeRouter>) =>
    expect(router.navigate).toHaveBeenCalledWith({ pathname: '/schedule', search: '', hash: '' }, { replace: true })

  it('fetches the payload over MessageChannel, strips the query and runs the same handler', async () => {
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    const { router, controller } = launch({ [NONCE]: tripIntent })
    await waitFor(() => expect(routeNavigations(router)).toEqual(['/expense']))
    expect(controller.postMessage).toHaveBeenCalledTimes(1)
    expect(controller.postMessage.mock.calls[0]![0]).toEqual({ type: NOTIFICATION_PAYLOAD_REQUEST, nonce: NONCE })
    stripped(router)
    expect(mocks.setSelectedTripId).toHaveBeenCalledWith('trip-1')
    expect(router.state.location.search).toBe('')
  })

  it("A's notification cold-started while B is signed in: no navigation, no trip switch", async () => {
    mocks.auth = signedIn(UID_B)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    const { router } = launch({ [NONCE]: tripIntent })
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith(NOTIFICATION_OPEN_COPY.otherAccount))
    stripped(router)
    expect(routeNavigations(router)).toEqual([])
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/schedule')
  })

  it('missing targetUid on cold start: no navigation', async () => {
    mocks.auth = signedIn(UID_A)
    const { router } = launch({ [NONCE]: { ...tripIntent, targetUid: undefined } })
    await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith(NOTIFICATION_OPEN_COPY.unknownRecipient))
    expect(routeNavigations(router)).toEqual([])
    expect(mocks.setSelectedTripId).not.toHaveBeenCalled()
  })

  it('expired / unknown nonce: stays on the default page', async () => {
    mocks.auth = signedIn(UID_A)
    const { router } = launch({})
    await waitFor(() => stripped(router))
    expect(routeNavigations(router)).toEqual([])
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  it('requests the nonce only once per page load (StrictMode re-mount)', async () => {
    mocks.auth = signedIn(UID_A)
    mocks.trips = { status: 'success', data: [{ id: 'trip-1' }] }
    const { router, controller, hook } = launch({ [NONCE]: tripIntent })
    hook.unmount()
    renderHook(() => useNotificationOpenHandler(router, fakeBridge().bridge))
    await waitFor(() => expect(routeNavigations(router)).toEqual(['/expense']))
    expect(controller.postMessage).toHaveBeenCalledTimes(1)
  })
})
