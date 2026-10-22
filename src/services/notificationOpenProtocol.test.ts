import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_OPEN_MESSAGE,
  NOTIFICATION_PAYLOAD_REQUEST,
  NOTIFY_NONCE_TTL_MS,
  chooseWindowClient,
  createNotificationNonceStore,
  hasNotifyParam,
  isNotificationPayloadRequest,
  isValidNotifyNonce,
  notificationOpenMessage,
  notifyLaunchUrl,
  parseNotificationOpenPayload,
  payloadFromPushData,
  readNotifyNonce,
  stripNotifyParam,
  type CacheLike,
  type NotificationOpenPayload,
} from './notificationOpenProtocol'

const tripPayload: NotificationOpenPayload = {
  scope: 'trip', route: '/expense', tripId: 'trip-1', targetUid: 'uid-a',
}
const NONCE = '0b7c2f1e-5a3d-4c8e-9f10-2a3b4c5d6e7f'

/** Cache Storage 的記憶體替身；`broken` 模擬配額 / 隱私模式錯誤。 */
function fakeCache(options: { broken?: boolean } = {}) {
  const entries = new Map<string, Response>()
  const fail = () => { if (options.broken) throw new Error('cache unavailable') }
  const cache: CacheLike = {
    async put(key, res) { fail(); entries.set(key, res) },
    async match(key) { fail(); return entries.get(key)?.clone() },
    async delete(key) { fail(); return entries.delete(key) },
    async keys() { fail(); return [...entries.keys()].map(url => ({ url })) },
  }
  return { cache, entries }
}

describe('parseNotificationOpenPayload', () => {
  it('accepts a whitelisted trip payload', () => {
    expect(parseNotificationOpenPayload(tripPayload)).toEqual(tripPayload)
  })

  it('accepts an account payload routed to /account', () => {
    const p = { scope: 'account', route: '/account', tripId: 'trip-1', targetUid: 'uid-a' }
    expect(parseNotificationOpenPayload(p)).toEqual(p)
  })

  it('keeps a payload without targetUid (the client refuses to navigate it)', () => {
    expect(parseNotificationOpenPayload({ ...tripPayload, targetUid: undefined })).toEqual({
      scope: 'trip', route: '/expense', tripId: 'trip-1',
    })
    expect(parseNotificationOpenPayload({ ...tripPayload, targetUid: '' })).not.toHaveProperty('targetUid')
  })

  it.each([
    ['route outside the whitelist', { ...tripPayload, route: '/admin' }],
    ['absolute / cross-origin route', { ...tripPayload, route: 'https://evil.test/expense' }],
    ['unknown scope', { ...tripPayload, scope: 'global' }],
    ['account scope with a trip route', { ...tripPayload, scope: 'account' }],
    ['trip scope routed to /account', { ...tripPayload, route: '/account' }],
    ['missing tripId', { ...tripPayload, tripId: '' }],
    ['oversized tripId', { ...tripPayload, tripId: 'x'.repeat(201) }],
    ['non-string targetUid', { ...tripPayload, targetUid: 42 }],
    ['oversized targetUid', { ...tripPayload, targetUid: 'u'.repeat(129) }],
    ['not an object', 'trip'],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(parseNotificationOpenPayload(raw)).toBeNull()
  })
})

describe('payloadFromPushData', () => {
  it('maps the Functions data payload (route lives in `url`)', () => {
    expect(payloadFromPushData({
      title: 'TripMate', body: '已新增費用', url: '/expense', scope: 'trip',
      tripId: 'trip-1', targetUid: 'uid-a', eventId: 'e1', tag: 't',
    })).toEqual(tripPayload)
  })

  it('returns null for legacy payloads without scope and for missing data', () => {
    expect(payloadFromPushData({ url: '/expense', tripId: 'trip-1', targetUid: 'uid-a' })).toBeNull()
    expect(payloadFromPushData(undefined)).toBeNull()
  })
})

describe('message shapes', () => {
  it('wraps the payload in a NOTIFICATION_OPEN message', () => {
    expect(notificationOpenMessage(tripPayload)).toEqual({ type: NOTIFICATION_OPEN_MESSAGE, ...tripPayload })
  })

  it('recognises payload requests only by type', () => {
    expect(isNotificationPayloadRequest({ type: NOTIFICATION_PAYLOAD_REQUEST, nonce: NONCE })).toBe(true)
    expect(isNotificationPayloadRequest({ type: 'SKIP_WAITING' })).toBe(false)
    expect(isNotificationPayloadRequest(null)).toBe(false)
  })
})

describe('launch URL', () => {
  it('carries only the opaque nonce on the default landing page', () => {
    const url = notifyLaunchUrl(NONCE)
    expect(url).toBe(`/schedule?notify=${NONCE}`)
    expect(url).not.toContain('uid')
    expect(readNotifyNonce(new URL(url, 'https://tripmate.test').search)).toBe(NONCE)
  })

  it('treats malformed nonces as absent but still detects the param', () => {
    expect(readNotifyNonce('?notify=../../x')).toBeNull()
    expect(hasNotifyParam('?notify=../../x')).toBe(true)
    expect(isValidNotifyNonce('short')).toBe(false)
  })

  it('strips only the notify param', () => {
    expect(stripNotifyParam(`?notify=${NONCE}`)).toBe('')
    expect(stripNotifyParam(`?a=1&notify=${NONCE}`)).toBe('?a=1')
  })
})

describe('chooseWindowClient', () => {
  const origin = 'https://tripmate.test'
  it('prefers focused, then visible, then any same-origin client', () => {
    const other = { url: 'https://other.test/', focused: true }
    const hidden = { url: `${origin}/expense`, visibilityState: 'hidden' as const }
    const visible = { url: `${origin}/wish`, visibilityState: 'visible' as const }
    const focused = { url: `${origin}/schedule`, focused: true }
    expect(chooseWindowClient([other, hidden, visible, focused], origin)).toBe(focused)
    expect(chooseWindowClient([other, hidden, visible], origin)).toBe(visible)
    expect(chooseWindowClient([other, hidden], origin)).toBe(hidden)
    expect(chooseWindowClient([other], origin)).toBeUndefined()
  })
})

describe('createNotificationNonceStore', () => {
  it('is one-shot: the second take returns null', async () => {
    const store = createNotificationNonceStore()
    await store.save(NONCE, tripPayload)
    expect(await store.take(NONCE)).toEqual(tripPayload)
    expect(await store.take(NONCE)).toBeNull()
  })

  it('expires after the TTL', async () => {
    let now = 1_000
    const store = createNotificationNonceStore({ now: () => now })
    await store.save(NONCE, tripPayload)
    now += NOTIFY_NONCE_TTL_MS
    expect(await store.take(NONCE)).toBeNull()
  })

  it('falls back to Cache Storage when the SW was restarted (memory lost)', async () => {
    const { cache, entries } = fakeCache()
    let now = 1_000
    const first = createNotificationNonceStore({ openCache: async () => cache, now: () => now })
    await first.save(NONCE, tripPayload)
    // 新的 store 實例 = SW 被終止後重新啟動。
    const restarted = createNotificationNonceStore({ openCache: async () => cache, now: () => now })
    now += 1_000
    expect(await restarted.take(NONCE)).toEqual(tripPayload)
    expect(entries.size).toBe(0)
    expect(await restarted.take(NONCE)).toBeNull()
  })

  it('does not resurrect an expired cache entry', async () => {
    const { cache } = fakeCache()
    let now = 1_000
    await createNotificationNonceStore({ openCache: async () => cache, now: () => now }).save(NONCE, tripPayload)
    now += NOTIFY_NONCE_TTL_MS + 1
    const restarted = createNotificationNonceStore({ openCache: async () => cache, now: () => now })
    expect(await restarted.take(NONCE)).toBeNull()
  })

  it('prunes expired cache entries on save', async () => {
    const { cache, entries } = fakeCache()
    let now = 1_000
    const store = createNotificationNonceStore({ openCache: async () => cache, now: () => now })
    await store.save(NONCE, tripPayload)
    now += NOTIFY_NONCE_TTL_MS + 1
    await store.save('1111aaaa-2222-3333-4444-555566667777', tripPayload)
    expect(entries.size).toBe(1)
  })

  it('still works from memory when Cache Storage throws', async () => {
    const { cache } = fakeCache({ broken: true })
    const store = createNotificationNonceStore({ openCache: async () => cache })
    await store.save(NONCE, tripPayload)
    expect(await store.take(NONCE)).toEqual(tripPayload)
  })

  it('rejects a tampered cache record', async () => {
    const { cache, entries } = fakeCache()
    const store = createNotificationNonceStore({ openCache: async () => cache })
    await store.save(NONCE, tripPayload)
    const [key] = [...entries.keys()]
    entries.set(key!, new Response(JSON.stringify({ payload: { ...tripPayload, route: '/admin' }, expiresAt: Date.now() + 60_000 })))
    const restarted = createNotificationNonceStore({ openCache: async () => cache })
    expect(await restarted.take(NONCE)).toBeNull()
  })
})
