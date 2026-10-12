import { afterEach, describe, expect, it, vi } from 'vitest'

const toastInfo = vi.fn()
vi.mock('@/shared/toast', () => ({ toast: { info: (m: string) => toastInfo(m) } }))

import {
  HAND_OFF_AFTER_MS, OFFLINE_HAND_OFF_MESSAGE, SLOW_HAND_OFF_MESSAGE, trackUnlessOffline,
} from './offlineHandOff'

function setOnline(value: boolean) {
  vi.stubGlobal('navigator', { onLine: value })
}

/** A write that never settles — what the Firestore SDK does with no backend. */
const hanging = () => new Promise<never>(() => {})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  toastInfo.mockReset()
})

describe('trackUnlessOffline', () => {
  it('online: returns the write for the form to track, with the form\'s liveness as reportInForm', () => {
    setOnline(true)
    const pending = Promise.resolve('ok')
    const write = vi.fn(() => pending)
    const stillOpen = () => true
    const close = vi.fn()

    expect(trackUnlessOffline(write, stillOpen, close)).toBe(pending)
    expect(write).toHaveBeenCalledWith(stillOpen)
    expect(close).not.toHaveBeenCalled()
  })

  it('offline: closes the form, hands failures to the global handler and tracks nothing', async () => {
    setOnline(false)
    const write = vi.fn((_report: () => boolean) => Promise.reject(new Error('never acked')))
    const close = vi.fn()

    expect(trackUnlessOffline(write, () => true, close)).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    expect(toastInfo).toHaveBeenCalledWith(OFFLINE_HAND_OFF_MESSAGE)
    // The form is gone, so the global MutationCache handler must report.
    expect(write.mock.calls[0]![0]()).toBe(false)
    await Promise.resolve()   // the rejection is swallowed here, not unhandled
  })

  it('"online" but unanswered: hands off after the delay while the same form is open', async () => {
    vi.useFakeTimers()
    setOnline(true)
    const close = vi.fn()
    trackUnlessOffline(hanging, () => true, close)

    await vi.advanceTimersByTimeAsync(HAND_OFF_AFTER_MS - 1)
    expect(close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(toastInfo).toHaveBeenCalledWith(SLOW_HAND_OFF_MESSAGE)
  })

  it('never closes once its own form is gone — close() would hit a form opened since', async () => {
    vi.useFakeTimers()
    setOnline(true)
    let open = true
    const close = vi.fn()
    trackUnlessOffline(hanging, () => open, close)

    open = false   // user dismissed it (and may have opened another form)
    await vi.advanceTimersByTimeAsync(HAND_OFF_AFTER_MS)
    expect(close).not.toHaveBeenCalled()
    expect(toastInfo).not.toHaveBeenCalled()
  })

  it('a write that settles in time cancels the hand-off', async () => {
    vi.useFakeTimers()
    setOnline(true)
    const close = vi.fn()
    const failing = trackUnlessOffline(() => Promise.reject(new Error('denied')), () => true, close)
    await expect(failing).rejects.toThrow('denied')
    trackUnlessOffline(() => Promise.resolve(), () => true, close)

    await vi.advanceTimersByTimeAsync(HAND_OFF_AFTER_MS)
    expect(close).not.toHaveBeenCalled()
  })
})
