import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  registerOptions: null as null | {
    onRegistered: (registration: ServiceWorkerRegistration | undefined) => void
    onRegisterError: (error: unknown) => void
  },
  needRefresh: false,
  refreshCompatibility: vi.fn(async () => ({ manifest: null, updateRequired: false })),
  syncFromStorage: vi.fn(),
  captureError: vi.fn(),
  updateServiceWorker: vi.fn(async () => undefined),
  setNeedRefresh: vi.fn(),
}))

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: NonNullable<typeof harness.registerOptions>) => {
    harness.registerOptions = options
    return {
      needRefresh: [harness.needRefresh, harness.setNeedRefresh],
      updateServiceWorker: harness.updateServiceWorker,
    }
  },
}))

vi.mock('@/services/clientCompatibility', () => ({
  CLIENT_COMPATIBILITY_STORAGE_KEY: 'tripmate:client-compatibility:v1',
  refreshClientCompatibility: harness.refreshCompatibility,
  syncClientCompatibilityFromStorage: harness.syncFromStorage,
}))

vi.mock('@/services/sentry', () => ({ captureError: harness.captureError }))

import { PwaUpdateProvider } from './PwaUpdateProvider'
import { usePwaUpdate } from '@/hooks/usePwaUpdate'

/** Drives requestUpdate through the real context and surfaces the busy flag
 *  so a test can assert the checking latch was released. */
function UpdateConsumer() {
  const { requestUpdate, checkingForUpdate } = usePwaUpdate()
  return (
    <button type="button" onClick={requestUpdate}>
      {checkingForUpdate ? 'checking' : 'request update'}
    </button>
  )
}

const renderWithConsumer = () => render(
  <PwaUpdateProvider><UpdateConsumer /></PwaUpdateProvider>,
)
const requestButton = () => screen.getByRole('button')

async function registerWorker(registration: ServiceWorkerRegistration) {
  await act(async () => {
    harness.registerOptions?.onRegistered(registration)
    await Promise.resolve()
  })
}

const originalLocation = window.location

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: originalLocation,
  })
})

beforeEach(() => {
  harness.registerOptions = null
  harness.needRefresh = false
  harness.refreshCompatibility.mockClear()
  harness.syncFromStorage.mockClear()
  harness.captureError.mockClear()
  harness.updateServiceWorker.mockClear()
  harness.setNeedRefresh.mockClear()
})

describe('PwaUpdateProvider lifecycle', () => {
  it('checks at root boot, synchronizes storage events, and removes every listener', async () => {
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const windowRemove = vi.spyOn(window, 'removeEventListener')
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const documentRemove = vi.spyOn(document, 'removeEventListener')

    const view = render(
      <PwaUpdateProvider><span>standalone route</span></PwaUpdateProvider>,
    )

    expect(screen.getByText('standalone route')).toBeTruthy()
    expect(harness.refreshCompatibility).toHaveBeenCalledOnce()
    expect(documentAdd).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(windowAdd).toHaveBeenCalledWith('online', expect.any(Function))
    expect(windowAdd).toHaveBeenCalledWith('pageshow', expect.any(Function))
    expect(windowAdd).toHaveBeenCalledWith('storage', expect.any(Function))

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'tripmate:client-compatibility:v1',
        newValue: '{"revision":2,"minimumWriteEpoch":2}',
      }))
    })
    expect(harness.syncFromStorage)
      .toHaveBeenCalledWith('{"revision":2,"minimumWriteEpoch":2}')

    view.unmount()
    expect(documentRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(windowRemove).toHaveBeenCalledWith('online', expect.any(Function))
    expect(windowRemove).toHaveBeenCalledWith('pageshow', expect.any(Function))
    expect(windowRemove).toHaveBeenCalledWith('storage', expect.any(Function))
  })

  it('shares the registered worker and refreshes compatibility from the registration callback', async () => {
    render(<PwaUpdateProvider><span>child</span></PwaUpdateProvider>)
    const update = vi.fn(async () => undefined)
    const registration = { update } as unknown as ServiceWorkerRegistration

    await act(async () => {
      harness.registerOptions?.onRegistered(registration)
      await Promise.resolve()
    })

    expect(update).toHaveBeenCalledOnce()
    // The boot check already stamped the manifest floor, so the registration
    // callback's manifest check is throttled away. The worker check still
    // fires because the two floors are tracked independently.
    expect(harness.refreshCompatibility).toHaveBeenCalledOnce()
  })

  it('captures a passive service-worker update failure instead of leaking a rejection', async () => {
    render(<PwaUpdateProvider><span>child</span></PwaUpdateProvider>)
    const failure = new Error('registration update failed')
    const registration = {
      update: vi.fn(async () => { throw failure }),
    } as unknown as ServiceWorkerRegistration

    await act(async () => {
      harness.registerOptions?.onRegistered(registration)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(harness.captureError)
      .toHaveBeenCalledWith(failure, { source: 'pwa-sw-update-check' })
  })

  it('retries after a failed check instead of burning the floor on it', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    try {
      harness.refreshCompatibility.mockRejectedValueOnce(new Error('offline'))
      render(<PwaUpdateProvider><span>child</span></PwaUpdateProvider>)
      await act(async () => { await Promise.resolve(); await Promise.resolve() })
      expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

      // Well inside the 30s floor, but the boot check failed — coming back
      // online is exactly the signal that says "retry now", so a floor that
      // counted the failure would strand an obsolete bundle until the timer.
      await act(async () => { window.dispatchEvent(new Event('online')) })
      expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('replays an online signal that arrived while a failing check was still in flight', async () => {
    let rejectBootCheck!: (error: Error) => void
    harness.refreshCompatibility.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectBootCheck = reject }),
    )
    render(<PwaUpdateProvider><span>child</span></PwaUpdateProvider>)
    expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

    // online fires while the boot check is still pending. It must not start a
    // duplicate, but it must not be forgotten either — the pending check may
    // predate the network coming back, so its failure proves nothing.
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

    await act(async () => {
      rejectBootCheck(new Error('offline'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)
  })

  it('throttles passive checks while keeping the worker and manifest floors independent', async () => {
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    try {
      render(<PwaUpdateProvider><span>child</span></PwaUpdateProvider>)
      expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

      const update = vi.fn(async () => undefined)
      await registerWorker({ update } as unknown as ServiceWorkerRegistration)
      // Runs even though the boot manifest check just stamped — a shared floor
      // would swallow the first post-launch worker check.
      expect(update).toHaveBeenCalledOnce()
      expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(update).toHaveBeenCalledOnce()
      expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

      nowSpy.mockReturnValue(1_000 + 30_001)
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(update).toHaveBeenCalledTimes(2)
      expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('keeps checking after a wall-clock rollback because the floor is monotonic', async () => {
    // The wall clock jumps back an hour (NTP sync / manual re-set) right after
    // the boot check. If the floor read Date.now(), the elapsed time would be
    // hugely negative and every passive check would be swallowed until the
    // clock caught back up — a stale bundle would never learn the new
    // minimumWriteEpoch. performance.now() is monotonic and doesn't care.
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    try {
      render(<PwaUpdateProvider><span>child</span></PwaUpdateProvider>)
      await act(async () => { await Promise.resolve() })
      expect(harness.refreshCompatibility).toHaveBeenCalledOnce()

      dateSpy.mockReturnValue(1_000_000 - 3_600_000)
      perfSpy.mockReturnValue(1_000 + 30_001)
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)
    } finally {
      dateSpy.mockRestore()
      perfSpy.mockRestore()
    }
  })
})

describe('requestUpdate recovery path', () => {
  it('activates immediately when a worker is already waiting', async () => {
    harness.needRefresh = true
    renderWithConsumer()

    await act(async () => { fireEvent.click(requestButton()) })

    expect(harness.updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('reloads when no registration exists to re-check', async () => {
    const reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    })
    renderWithConsumer()

    await act(async () => { fireEvent.click(requestButton()) })

    expect(reload).toHaveBeenCalledOnce()
    expect(harness.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('activates the worker a fresh check discovers', async () => {
    const update = vi.fn(async () => undefined)
    renderWithConsumer()
    await registerWorker({ update, waiting: {} } as unknown as ServiceWorkerRegistration)
    update.mockClear()

    await act(async () => { fireEvent.click(requestButton()) })

    expect(update).toHaveBeenCalledOnce()
    expect(harness.updateServiceWorker).toHaveBeenCalledWith(true)
    expect(requestButton().textContent).toBe('request update')
  })

  it('re-checks without activating when nothing is waiting', async () => {
    const update = vi.fn(async () => undefined)
    renderWithConsumer()
    await registerWorker({ update, waiting: null } as unknown as ServiceWorkerRegistration)
    update.mockClear()

    await act(async () => { fireEvent.click(requestButton()) })

    expect(update).toHaveBeenCalledOnce()
    expect(harness.updateServiceWorker).not.toHaveBeenCalled()
    expect(requestButton().textContent).toBe('request update')
  })

  it('releases the checking latch after a failed check so the user can retry', async () => {
    const update = vi.fn(async () => undefined)
    renderWithConsumer()
    await registerWorker({ update, waiting: null } as unknown as ServiceWorkerRegistration)
    const failure = new Error('check failed')
    update.mockClear()
    update.mockImplementationOnce(async () => { throw failure })

    await act(async () => { fireEvent.click(requestButton()) })

    expect(harness.captureError)
      .toHaveBeenCalledWith(failure, { source: 'pwa-sw-update-check' })
    expect(requestButton().textContent).toBe('request update')

    await act(async () => { fireEvent.click(requestButton()) })

    expect(update).toHaveBeenCalledTimes(2)
  })

  it('refreshes the manifest too, so an emergency rollback lands without waiting', async () => {
    const update = vi.fn(async () => undefined)
    renderWithConsumer()
    await registerWorker({ update, waiting: null } as unknown as ServiceWorkerRegistration)
    harness.refreshCompatibility.mockClear()
    update.mockClear()

    await act(async () => { fireEvent.click(requestButton()) })

    // Bypasses the passive floor that boot + registration just stamped.
    expect(harness.refreshCompatibility).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
  })

  it('fetches fresh after a colliding passive check settles instead of riding it', async () => {
    const perfSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    try {
      const update = vi.fn(async () => undefined)
      renderWithConsumer()
      await registerWorker({ update, waiting: null } as unknown as ServiceWorkerRegistration)

      // A passive manifest check goes up and stays pending.
      let rejectPassive!: (error: Error) => void
      harness.refreshCompatibility.mockImplementationOnce(
        () => new Promise((_, reject) => { rejectPassive = reject }),
      )
      perfSpy.mockReturnValue(1_000 + 30_001)
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)

      // The CTA lands while that request is still in flight. The service
      // single-flight would hand the pre-tap request back, so the forced
      // check must WAIT for it and then issue a fresh GET — a failed (or
      // pre-rollback) passive response must not make the tap a silent no-op.
      await act(async () => { fireEvent.click(requestButton()) })
      expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)
      expect(requestButton().textContent).toBe('checking')

      await act(async () => {
        rejectPassive(new Error('offline'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(harness.refreshCompatibility).toHaveBeenCalledTimes(3)
      // The checking latch waited for the fresh fetch, not the doomed one.
      expect(requestButton().textContent).toBe('request update')
    } finally {
      perfSpy.mockRestore()
    }
  })
})
