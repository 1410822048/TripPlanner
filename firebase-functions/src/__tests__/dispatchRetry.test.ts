import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedPushEvent } from '../model.js'

const harness = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  sendEach: vi.fn(), inbox: vi.fn(),
}))
vi.mock('firebase-functions/logger', () => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('../notifications.js', () => ({ writeNotificationDocs: harness.inbox }))
vi.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ sendEach: harness.sendEach }) }))
vi.mock('firebase-admin/firestore', () => {
  function snapshot(path: string) {
    const data = harness.rows.get(path)
    return { exists: !!data, data: () => data, get: (field: string) => data?.[field] }
  }
  function set(path: string, patch: Record<string, unknown>) {
    const data = { ...harness.rows.get(path) }
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === 'object' && 'op' in value) {
        const transform = value as { op: string; values?: string[]; count?: number }
        if (transform.op === 'delete') delete data[key]
        if (transform.op === 'union') data[key] = [...new Set([...(data[key] as string[] ?? []), ...transform.values!])]
        if (transform.op === 'increment') data[key] = Number(data[key] ?? 0) + transform.count!
      } else data[key] = value
    }
    harness.rows.set(path, data)
  }
  function doc(path: string) {
    return { path, get: async () => snapshot(path), set: async (patch: Record<string, unknown>) => set(path, patch),
      update: async (patch: Record<string, unknown>) => set(path, patch) }
  }
  return {
    FieldValue: {
      serverTimestamp: () => 'now', delete: () => ({ op: 'delete' }),
      arrayUnion: (...values: string[]) => ({ op: 'union', values }),
      increment: (count: number) => ({ op: 'increment', count }),
    },
    Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
    getFirestore: () => ({
      doc,
      runTransaction: async (callback: (tx: object) => Promise<unknown>) => callback({
        get: async (ref: { path: string }) => snapshot(ref.path),
        set: (ref: { path: string }, patch: Record<string, unknown>) => set(ref.path, patch),
        create: (ref: { path: string }, patch: Record<string, unknown>) => set(ref.path, patch),
      }),
      collection: (path: string) => {
        const query = {
          where: () => query, orderBy: () => query, limit: () => query,
          get: async () => ({ docs: [...harness.rows.entries()]
            .filter(([key, row]) => key.startsWith(`${path}/`) && row.disabledAt === null)
            .map(([key, row]) => ({ id: key.split('/').at(-1), get: (field: string) => row[field] })) }),
        }
        return query
      },
    }),
  }
})
import { dispatchPushEvent, MAX_DISPATCH_ATTEMPTS } from '../dispatch.js'
import { sendPush, pushTokenKey } from '../send.js'

const event: NormalizedPushEvent = {
  eventId: 'e', tripId: 't', entityType: 'expense', entityId: 'expense',
  action: 'created', actorUid: 'actor', route: '/expense', templateKey: 'expense.created',
}
function responses(codes: (string | null)[]) {
  return { successCount: codes.filter(code => code === null).length,
    failureCount: codes.filter(code => code !== null).length,
    responses: codes.map(code => code === null ? { success: true } : { success: false, error: { code } }) }
}
beforeEach(() => {
  harness.rows.clear()
  harness.sendEach.mockReset()
  harness.inbox.mockReset().mockResolvedValue(undefined)
  harness.rows.set('trips/t', { memberIds: ['actor', 'u'], title: 'Trip' })
  for (const name of ['ok', 'retry', 'invalid']) {
    harness.rows.set(`users/u/pushTokens/${name}`, { disabledAt: null, token: name.padEnd(25, '-') })
  }
})

describe('durable push retries', () => {
  it('retries only transient failures after partial success, retaining terminal counts', async () => {
    harness.sendEach.mockResolvedValueOnce(responses([null, 'messaging/unavailable', 'messaging/registration-token-not-registered']))
    await expect(dispatchPushEvent(event)).rejects.toThrow('Retryable FCM')
    expect(harness.rows.get('_pushEvents/e')).toMatchObject({ status: 'retry', sentCount: 1, failedCount: 2,
      completedTokenKeys: [pushTokenKey({ uid: 'u', tokenHash: 'ok' }), pushTokenKey({ uid: 'u', tokenHash: 'invalid' })] })
    harness.sendEach.mockResolvedValueOnce(responses([null]))
    await dispatchPushEvent(event)
    expect(harness.sendEach.mock.calls[1]![0]).toEqual([expect.objectContaining({ token: 'retry'.padEnd(25, '-') })])
    expect(harness.rows.get('_pushEvents/e')).toMatchObject({ status: 'partial', sentCount: 2, failedCount: 1, attempt: 2 })
    await dispatchPushEvent(event)
    expect(harness.sendEach).toHaveBeenCalledTimes(2)
  })
  it('checkpoints each completed batch before a subsequent FCM batch throws', async () => {
    const tokens = Array.from({ length: 501 }, (_, index) => ({ uid: 'u', tokenHash: String(index), token: `token-${index}` }))
    harness.sendEach.mockResolvedValueOnce(responses(Array(500).fill(null))).mockRejectedValueOnce(new Error('connection lost'))
    const checkpoint = vi.fn().mockResolvedValue(undefined)
    await expect(sendPush(event, tokens, checkpoint)).rejects.toThrow('connection lost')
    expect(checkpoint).toHaveBeenCalledOnce()
    expect(checkpoint.mock.calls[0]![0].completedTokens).toHaveLength(500)
  })
  it('preserves earlier deliveries across an invocation crash and expired lease', async () => {
    harness.rows.set('_pushEvents/e', { status: 'pending', attempt: 1, leaseExpiresAt: { toMillis: () => 0 },
      completedTokenKeys: [pushTokenKey({ uid: 'u', tokenHash: 'ok' })], sentCount: 1, terminalFailedCount: 0 })
    harness.sendEach.mockResolvedValueOnce(responses([null, null]))
    await dispatchPushEvent(event)
    expect(harness.sendEach.mock.calls[0]![0]).toHaveLength(2)
    expect(harness.rows.get('_pushEvents/e')).toMatchObject({ status: 'sent', sentCount: 3, attempt: 2 })
  })
  it('caps persistent transient failures without resending successful devices', async () => {
    harness.rows.delete('users/u/pushTokens/invalid')
    harness.sendEach.mockResolvedValueOnce(responses([null, 'messaging/unavailable']))
    await expect(dispatchPushEvent(event)).rejects.toThrow('Retryable FCM')
    for (let attempt = 2; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      harness.sendEach.mockResolvedValueOnce(responses(['messaging/unavailable']))
      if (attempt < MAX_DISPATCH_ATTEMPTS) await expect(dispatchPushEvent(event)).rejects.toThrow('Retryable FCM')
      else await dispatchPushEvent(event)
    }
    await dispatchPushEvent(event)
    expect(harness.sendEach).toHaveBeenCalledTimes(MAX_DISPATCH_ATTEMPTS)
    expect(harness.rows.get('_pushEvents/e')).toMatchObject({ status: 'partial', sentCount: 1, failedCount: 1,
      lastError: 'FCM retry attempts exhausted' })
  })
  it('defers while another invocation holds a live lease without sending', async () => {
    harness.rows.set('_pushEvents/e', { status: 'pending', attempt: 1, leaseExpiresAt: { toMillis: () => Date.now() + 60_000 } })
    await expect(dispatchPushEvent(event)).rejects.toThrow('held by an active lease')
    expect(harness.sendEach).not.toHaveBeenCalled()
    expect(harness.inbox).not.toHaveBeenCalled()
  })
})
