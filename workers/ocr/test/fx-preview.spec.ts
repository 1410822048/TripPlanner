// /fx-rate — FX preview answered from the write path's resolveFxRate.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { docFields, resolveCalls } = vi.hoisted(() => ({
  docFields:    new Map<string, Record<string, unknown> | null>(),
  resolveCalls: [] as unknown[],
}))

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'admin-token'),
  getProjectId:  vi.fn(() => 'demo'),
}))
vi.mock('../src/firestore', async () => {
  const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
  return { ...actual, getDocFields: vi.fn(async (_t: string, _p: string, path: string) => docFields.get(path) ?? null) }
})
vi.mock('../src/fx-rate', async () => {
  const actual = await vi.importActual<typeof import('../src/fx-rate')>('../src/fx-rate')
  return {
    ...actual,
    resolveFxRate: vi.fn(async (input: { sourceCurrency: string; tripCurrency: string }) => {
      resolveCalls.push(input)
      return input.sourceCurrency === input.tripCurrency
        ? null
        : { rateDecimal: '150.25', rateDate: '2026-10-06', fetchedAtMs: 0 }
    }),
  }
})

import { fxPreview, FxPreviewRequestSchema } from '../src/fx-preview'

const TRIP = 'trip-1'
const UID  = 'caller'
const req = (sourceCurrency = 'USD') => ({ tripId: TRIP, requestedDate: '2026-10-07', sourceCurrency })

beforeEach(() => {
  docFields.clear()
  resolveCalls.length = 0
  docFields.set(`trips/${TRIP}`, { currency: { stringValue: 'JPY' } })
  docFields.set(`trips/${TRIP}/members/${UID}`, { role: { stringValue: 'viewer' } })
})

describe('fxPreview', () => {
  it('answers with the cache-aware rate, using the trip currency from the trip doc', async () => {
    await expect(fxPreview(UID, req(), '{}')).resolves.toEqual({
      degenerate: false, tripCurrency: 'JPY', rateDecimal: '150.25', rateDate: '2026-10-06',
    })
    expect(resolveCalls).toEqual([{ requestedDate: '2026-10-07', sourceCurrency: 'USD', tripCurrency: 'JPY' }])
  })

  it('reports the degenerate same-currency case', async () => {
    await expect(fxPreview(UID, req('JPY'), '{}')).resolves.toEqual({ degenerate: true, tripCurrency: 'JPY' })
  })

  it('refuses strangers and members being removed; 404 / 410 first', async () => {
    docFields.delete(`trips/${TRIP}/members/${UID}`)
    await expect(fxPreview(UID, req(), '{}')).rejects.toMatchObject({ status: 403 })
    docFields.set(`trips/${TRIP}/members/${UID}`, { role: { stringValue: 'editor' }, removingAt: { timestampValue: '2026-10-07T00:00:00Z' } })
    await expect(fxPreview(UID, req(), '{}')).rejects.toMatchObject({ status: 403 })
    docFields.set(`trips/${TRIP}`, { deletingAt: { timestampValue: '2026-10-07T00:00:00Z' } })
    await expect(fxPreview(UID, req(), '{}')).rejects.toMatchObject({ status: 410 })
    docFields.delete(`trips/${TRIP}`)
    await expect(fxPreview(UID, req(), '{}')).rejects.toMatchObject({ status: 404 })
    expect(resolveCalls).toEqual([])
  })

  it('rejects malformed or extra request fields', () => {
    expect(FxPreviewRequestSchema.safeParse({ ...req(), tripCurrency: 'USD' }).success).toBe(false)
    expect(FxPreviewRequestSchema.safeParse({ ...req('usd') }).success).toBe(false)
  })
})
