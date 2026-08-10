// The future-date gate here is the one that decides whether a
// foreign-currency expense can be saved at all: with no rate,
// buildExpenseFormResult refuses to submit. Every component test around it
// mocks this hook out, so the bug it used to have — comparing the user's
// LOCAL date against UTC today — was invisible to the whole suite.
//
// The two dates are different questions and are tested as such: what the
// user may ask for is bounded by their own day, what the provider may
// answer with is bounded by UTC's. `toLocalDateString` is stubbed rather
// than simulated with a timezone, because what is under test is which
// bound applies where — the formatting has its own tests in utils/dates.
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tokyo (UTC+9) at 08:00 on the 31st is still 2026-05-30T23:00Z.
const LOCAL_TODAY = '2026-05-31'
const UTC_NOW     = new Date('2026-05-30T23:00:00Z')

vi.mock('@/utils/dates', () => ({ toLocalDateString: () => LOCAL_TODAY }))

import { useFxPreview } from './useFxPreview'

function render(requestedDate: string) {
  // One client per render call, NOT one per re-render: building it inside
  // the wrapper resets every query on each render pass, and an error state
  // never survives long enough to observe.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return renderHook(
    () => useFxPreview({ requestedDate, sourceCurrency: 'USD', tripCurrency: 'JPY' }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  )
}

/** Frankfurter v2 wraps even single-quote responses in an array. */
function providerOk(date: string) {
  return new Response(
    JSON.stringify([{ date, base: 'USD', quote: 'JPY', rate: 146.2 }]),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

beforeEach(() => {
  // shouldAdvanceTime keeps waitFor's real-timer polling alive while the
  // system clock stays pinned for todayUtc().
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(UTC_NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useFxPreview — the date the user may ask for', () => {
  it('enables the preview for local today even though UTC is still yesterday', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(providerOk('2026-05-30'))

    const { result } = render(LOCAL_TODAY)

    // The bug: this used to be 'future-date', which also blocked saving.
    expect(result.current.disabledReason).toBeNull()
    await waitFor(() => expect(result.current.rateDecimal).toBe('146.2'))
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('still refuses local tomorrow', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const { result } = render('2026-06-01')

    expect(result.current.disabledReason).toBe('future-date')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('useFxPreview — the date the provider may answer with', () => {
  it('rejects a rate dated after the current UTC day', async () => {
    // The request is legitimately UTC+1, so `rateDate <= requestedDate`
    // passes and only the UTC ceiling catches this.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerOk('2026-05-31'))

    const { result } = render(LOCAL_TODAY)

    // The hook pins `retry: 1` itself, so the error state only settles
    // after a backoff the default waitFor window would not cover.
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 5_000 })
    expect(result.current.rateDecimal).toBeNull()
  })

  it('accepts a rate dated on or before the current UTC day', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(providerOk('2026-05-29'))

    const { result } = render(LOCAL_TODAY)

    await waitFor(() => expect(result.current.rateDecimal).toBe('146.2'))
    expect(result.current.rateDate).toBe('2026-05-29')
  })
})
