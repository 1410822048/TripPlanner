// The envelope is hand-rolled (no @sentry/cloudflare), so its framing is
// ours to get right. The item header declares a byte length and Sentry
// reads exactly that many bytes — a wrong number truncates the payload and
// the event is dropped as malformed, silently, which is the one failure
// mode error reporting must not have.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { captureMessage, serializeErrorChain } from '../src/sentry'

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

// The Worker wraps errors — cron re-throws attach counts, token
// verification narrows the message — and the wrapper's stack says only
// where the wrapping happened. Neither half of the original survives a
// plain JSON.stringify: `cause` is non-enumerable and the outer stack does
// NOT contain the inner one, so reporting `{ stack, name }` threw away the
// frames that actually name the failure.
describe('serializeErrorChain', () => {
  it('carries the cause chain, which neither stack nor JSON does alone', () => {
    const inner = new Error('firestore 503')
    const outer = new Error('cron failed (scanned=4)', { cause: inner })

    // The premise, asserted rather than assumed.
    expect(outer.stack).not.toContain('firestore 503')
    expect(JSON.stringify(outer)).not.toContain('firestore 503')

    const serialized = serializeErrorChain(outer)
    expect(serialized.message).toBe('cron failed (scanned=4)')
    expect(serialized.cause?.message).toBe('firestore 503')
    expect(serialized.cause?.stack).toBe(inner.stack)
    expect(JSON.stringify(serialized)).toContain('firestore 503')
  })

  it('stops at three levels so a cycle cannot unbound the payload', () => {
    const a: Error & { cause?: unknown } = new Error('a')
    const b = new Error('b', { cause: a })
    a.cause = b   // cycle

    const serialized = serializeErrorChain(b)
    let depth = 0
    for (let node = serialized.cause; node; node = node.cause) depth++
    expect(depth).toBe(3)
    expect(() => JSON.stringify(serialized)).not.toThrow()
  })

  it('normalizes a non-Error throw instead of losing it', () => {
    const serialized = serializeErrorChain('a bare string')
    expect(serialized.message).toBe('a bare string')
    expect(serialized.name).toBe('Error')
  })
})
