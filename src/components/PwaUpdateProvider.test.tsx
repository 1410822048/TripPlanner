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
    // One independent boot check plus the registration callback. The real
    // service single-flights these if they overlap.
    expect(harness.refreshCompatibility).toHaveBeenCalledTimes(2)
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
})
