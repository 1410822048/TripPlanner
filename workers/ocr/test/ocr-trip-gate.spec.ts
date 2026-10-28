// /ocr, /booking-pdf-extract trip gate (ocr-trip-gate.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { docFields } = vi.hoisted(() => ({
  docFields: new Map<string, Record<string, unknown> | null>(),
}))

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'admin-token'),
  getProjectId:  vi.fn(() => 'demo'),
}))

vi.mock('../src/firestore', async () => {
  const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
  return {
    ...actual,
    getDocFields: vi.fn(async (_token: string, _pid: string, path: string) => docFields.get(path) ?? null),
  }
})

import { assertOcrTripAccess } from '../src/ocr-trip-gate'
import { OcrRequestSchema } from '../src/schema'
import { BookingPdfExtractRequestSchema } from '../src/booking-pdf-extract'

const TRIP = 'trip-1'
const UID  = 'caller'
const member = (role: string, extra: Record<string, unknown> = {}) => ({ role: { stringValue: role }, ...extra })

beforeEach(() => {
  docFields.clear()
  docFields.set(`trips/${TRIP}`, { ownerId: { stringValue: 'owner' } })
})

describe('assertOcrTripAccess', () => {
  it.each(['owner', 'editor'])('allows an active %s', async role => {
    docFields.set(`trips/${TRIP}/members/${UID}`, member(role))
    await expect(assertOcrTripAccess('{}', TRIP, UID)).resolves.toBeUndefined()
  })

  it('refuses a viewer', async () => {
    docFields.set(`trips/${TRIP}/members/${UID}`, member('viewer'))
    await expect(assertOcrTripAccess('{}', TRIP, UID)).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a stranger', async () => {
    await expect(assertOcrTripAccess('{}', TRIP, UID)).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a member being removed', async () => {
    docFields.set(`trips/${TRIP}/members/${UID}`, member('editor', { removingAt: { timestampValue: '2026-10-07T00:00:00Z' } }))
    await expect(assertOcrTripAccess('{}', TRIP, UID)).rejects.toMatchObject({ status: 403 })
  })

  it('answers 404 / 410 before membership', async () => {
    await expect(assertOcrTripAccess('{}', 'missing', UID)).rejects.toMatchObject({ status: 404 })
    docFields.set(`trips/${TRIP}`, { deletingAt: { timestampValue: '2026-10-07T00:00:00Z' } })
    await expect(assertOcrTripAccess('{}', TRIP, UID)).rejects.toMatchObject({ status: 410 })
  })
})

describe('request schemas require tripId', () => {
  it('OCR request', () => {
    const base = { image: 'a'.repeat(200), mimeType: 'image/jpeg' as const }
    expect(OcrRequestSchema.parse({ ...base, tripId: TRIP }).tripId).toBe(TRIP)
    expect(OcrRequestSchema.safeParse({ ...base, tripId: '../x' }).success).toBe(false)
    expect(OcrRequestSchema.safeParse(base).success).toBe(false)
  })

  it('booking PDF request', () => {
    const r = BookingPdfExtractRequestSchema.safeParse({
      tripId: TRIP, pageCount: 1, text: 'x'.repeat(30),
      lines: [{ page: 1, text: 'hello', x: 0, y: 0 }],
    })
    expect(r.success).toBe(true)
    expect(BookingPdfExtractRequestSchema.safeParse({
      pageCount: 1, text: 'x'.repeat(30),
      lines: [{ page: 1, text: 'hello', x: 0, y: 0 }],
    }).success).toBe(false)
  })
})
