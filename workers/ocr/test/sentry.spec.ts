// The envelope is hand-rolled (no @sentry/cloudflare), so its framing is
// ours to get right. The item header declares a byte length and Sentry
// reads exactly that many bytes — a wrong number truncates the payload and
// the event is dropped as malformed, silently, which is the one failure
// mode error reporting must not have.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureMessage } from '../src/sentry'

const DSN = 'https://pubkey@o123.ingest.sentry.io/456'

function envelopeFrom(fetchMock: ReturnType<typeof vi.fn>): {
  itemHeader: { length: number }
  itemBodyRaw: string
} {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
  const [, headerLine, bodyLine] = init.body.split('\n')
  return {
    itemHeader:  JSON.parse(headerLine!) as { length: number },
    itemBodyRaw: bodyLine!,
  }
}

describe('captureMessage envelope framing', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('declares the UTF-8 BYTE length, not the UTF-16 code-unit count', async () => {
    // Traditional Chinese is 3 UTF-8 bytes per character but 1 code unit,
    // so `.length` would under-declare by ~2/3 of the message.
    await captureMessage({ SENTRY_DSN: DSN }, '[expense-update] 伺服器忙碌，請稍後再試', 'error')

    const { itemHeader, itemBodyRaw } = envelopeFrom(fetchMock)
    const actualBytes = new TextEncoder().encode(itemBodyRaw).byteLength
    expect(itemHeader.length).toBe(actualBytes)
    // Guard against the bug reappearing as a coincidence on ASCII input.
    expect(itemHeader.length).toBeGreaterThan(itemBodyRaw.length)
  })

  it('still matches for a pure-ASCII payload', async () => {
    await captureMessage({ SENTRY_DSN: DSN }, '[cron] receipt-purge failed', 'error')

    const { itemHeader, itemBodyRaw } = envelopeFrom(fetchMock)
    expect(itemHeader.length).toBe(new TextEncoder().encode(itemBodyRaw).byteLength)
    expect(itemHeader.length).toBe(itemBodyRaw.length)
  })

  it('counts non-ASCII carried in `extra` too (stack traces quote error messages)', async () => {
    await captureMessage({ SENTRY_DSN: DSN }, 'boom', 'error', {}, {
      stack: 'Error: 找不到該筆費用\n    at doUpdate (expense-write.ts:1)',
    })

    const { itemHeader, itemBodyRaw } = envelopeFrom(fetchMock)
    expect(itemHeader.length).toBe(new TextEncoder().encode(itemBodyRaw).byteLength)
    expect(itemHeader.length).toBeGreaterThan(itemBodyRaw.length)
  })

  it('is a no-op when the DSN is unset, so an unconfigured Worker sends nothing', async () => {
    await captureMessage({}, 'boom', 'error')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
