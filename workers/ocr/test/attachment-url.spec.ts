// Tests for the attachment signed-URL endpoint (attachment-url.ts).
//
// The whole point of routing through the Worker is the authz surface
// (trip-member gate, entity-ref BOLA path derivation), so it's exercised
// exhaustively here. External deps (admin token, Firestore reads, the V4
// signer) are mocked; the REAL readNestedString / readTimestampMs /
// CascadeError / withTokenRetry run against the fixtures. signV4Url is mocked
// to a deterministic stub so we assert WHICH object path + TTL the handler
// chose, without doing real crypto (that's gcs-sign.spec).
//
// Signed reads are full/pdf only — thumb signing was removed (thumbnails stay
// on getBlob; see docs/design/attachment-signed-url-v2.md §7).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { docFields, signCalls } = vi.hoisted(() => ({
  docFields: new Map<string, Record<string, unknown> | null>(),
  signCalls: [] as Array<{ objectPath: string; expiresSeconds: number; bucket: string }>,
}))

vi.mock('../src/admin', () => ({
  getAdminToken:        vi.fn(async () => 'admin-token'),
  getProjectId:         vi.fn(() => 'demo'),
  getSigningCredentials: vi.fn(() => ({ clientEmail: 'sa@x.iam', privateKey: 'pk' })),
  invalidateAdminToken: vi.fn(),
}))

vi.mock('../src/firestore', async () => {
  const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
  return {
    ...actual,
    getDocFields: vi.fn(async (_token: string, _pid: string, path: string) => docFields.get(path) ?? null),
  }
})

vi.mock('../src/gcs-sign', () => ({
  signV4Url: vi.fn(async (args: { objectPath: string; expiresSeconds: number; bucket: string }) => {
    signCalls.push({ objectPath: args.objectPath, expiresSeconds: args.expiresSeconds, bucket: args.bucket })
    return { url: `signed:${args.objectPath}`, expiresAt: '2026-06-09T12:30:00Z' }
  }),
}))

import { signEntityUrl, AttachmentUrlRequestSchema } from '../src/attachment-url'
import { CascadeError } from '../src/cascade'

const TRIP   = 'trip-1'
const CALLER = 'caller-uid'
const SA     = '{}'
const BUCKET = 'demo-bucket'

function str(s: string) { return { stringValue: s } }
function ts(s: string)  { return { timestampValue: s } }

function seedTrip(opts: { deletingAt?: boolean } = {}): void {
  const f: Record<string, unknown> = { currency: str('JPY') }
  if (opts.deletingAt) f.deletingAt = ts('2026-06-09T00:00:00Z')
  docFields.set(`trips/${TRIP}`, f)
}
function seedMember(uid: string, role: 'owner' | 'editor' | 'viewer' = 'viewer'): void {
  docFields.set(`trips/${TRIP}/members/${uid}`, { role: str(role) })
}
function mapVal(fields: Record<string, unknown>) { return { mapValue: { fields } } }

beforeEach(() => {
  docFields.clear()
  signCalls.length = 0
})

// ─── Entity-ref full/pdf ───────────────────────────────────────────

function seedEntity(
  type: 'expense' | 'booking' | 'wish',
  fields: Record<string, unknown>,
  id = 'e1',
): void {
  const coll = type === 'expense' ? 'expenses' : type === 'booking' ? 'bookings' : 'wishes'
  docFields.set(`trips/${TRIP}/${coll}/${id}`, fields)
}

describe('signEntityUrl — derive path from doc', () => {
  it('expense full → derives receipt.path, 10min TTL', async () => {
    seedTrip(); seedMember(CALLER, 'viewer')
    const path = `trips/${TRIP}/expenses/e1/r.webp`
    seedEntity('expense', { receipt: mapVal({ path: str(path), type: str('image/webp') }) })
    const out = await signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET)
    expect(out.url).toBe(`signed:${path}`)
    expect(signCalls).toEqual([{ objectPath: path, expiresSeconds: 10 * 60, bucket: BUCKET }])
  })

  it('expense pdf → 5min TTL', async () => {
    seedTrip(); seedMember(CALLER)
    const path = `trips/${TRIP}/expenses/e1/r.pdf`
    seedEntity('expense', { receipt: mapVal({ path: str(path), type: str('application/pdf') }) })
    await signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'pdf' }, SA, BUCKET)
    expect(signCalls[0].expiresSeconds).toBe(5 * 60)
  })

  it('booking full → derives document.filePath', async () => {
    seedTrip(); seedMember(CALLER)
    const path = `trips/${TRIP}/bookings/e1/f.jpg`
    seedEntity('booking', { document: mapVal({ filePath: str(path), fileType: str('image/jpeg') }) })
    await signEntityUrl(CALLER, { tripId: TRIP, entityType: 'booking', entityId: 'e1', variant: 'full' }, SA, BUCKET)
    expect(signCalls[0].objectPath).toBe(path)
  })

  it('wish full → derives image.path', async () => {
    seedTrip(); seedMember(CALLER)
    const path = `trips/${TRIP}/wishes/e1/i.webp`
    seedEntity('wish', { image: mapVal({ path: str(path) }) })
    await signEntityUrl(CALLER, { tripId: TRIP, entityType: 'wish', entityId: 'e1', variant: 'full' }, SA, BUCKET)
    expect(signCalls[0].objectPath).toBe(path)
  })
})

describe('signEntityUrl — authorization + integrity', () => {
  const seedOkExpense = () =>
    seedEntity('expense', { receipt: mapVal({ path: str(`trips/${TRIP}/expenses/e1/r.webp`), type: str('image/webp') }) })

  it('non-member → 403', async () => {
    seedTrip(); seedOkExpense()
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 403 })
    expect(signCalls).toHaveLength(0)
  })

  it('trip deleting → 410 / entity not found → 404', async () => {
    seedTrip({ deletingAt: true }); seedMember(CALLER); seedOkExpense()
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 410 })
    seedTrip() // not deleting, but no entity doc
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'missing', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 404 })
  })

  it('entity with no attachment field → 404', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('expense', { title: str('no receipt') })
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 404 })
  })

  it('soft-deleted expense → 404', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('expense', {
      receipt:   mapVal({ path: str(`trips/${TRIP}/expenses/e1/r.webp`), type: str('image/webp') }),
      deletedAt: ts('2026-06-08T00:00:00Z'),
    })
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 404 })
  })

  it('derived path under a different trip/entity → 400 (BOLA)', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('expense', { receipt: mapVal({ path: str(`trips/other-trip/expenses/e1/r.webp`), type: str('image/webp') }) })
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 400 })
    expect(signCalls).toHaveLength(0)
  })

  it('variant=pdf but stored type is image → 415', async () => {
    seedTrip(); seedMember(CALLER); seedOkExpense()
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'pdf' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 415 })
  })

  it('variant=full but stored type is pdf → 415', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('expense', { receipt: mapVal({ path: str(`trips/${TRIP}/expenses/e1/r.pdf`), type: str('application/pdf') }) })
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 415 })
  })

  it('expense attachment missing its content type → 500 (corrupt doc, no signing)', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('expense', { receipt: mapVal({ path: str(`trips/${TRIP}/expenses/e1/r.webp`) }) }) // no `type`
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 500 })
    expect(signCalls).toHaveLength(0)
  })

  it('booking document missing its fileType → 500 (corrupt doc)', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('booking', { document: mapVal({ filePath: str(`trips/${TRIP}/bookings/e1/f.pdf`) }) }) // no `fileType`
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'booking', entityId: 'e1', variant: 'pdf' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 500 })
  })

  it('wish + variant=pdf → 400 (wish is image-only)', async () => {
    seedTrip(); seedMember(CALLER)
    seedEntity('wish', { image: mapVal({ path: str(`trips/${TRIP}/wishes/e1/i.webp`) }) })
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'wish', entityId: 'e1', variant: 'pdf' }, SA, BUCKET))
      .rejects.toMatchObject({ status: 400 })
  })

  it('throws CascadeError (not generic Error) so the route maps the status', async () => {
    await expect(signEntityUrl(CALLER, { tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' }, SA, BUCKET))
      .rejects.toBeInstanceOf(CascadeError)
  })
})

// ─── Schema strictness ─────────────────────────────────────────────

describe('request schema — strict', () => {
  it('entity schema: accepts exact booking path locator, rejects non-booking path / smuggled url / bad variant', () => {
    const ok = AttachmentUrlRequestSchema.safeParse({ tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full' })
    expect(ok.success).toBe(true)
    expect(AttachmentUrlRequestSchema.safeParse({ tripId: TRIP, entityType: 'booking', entityId: 'e1', variant: 'full', path: 'x' }).success).toBe(true)
    expect(AttachmentUrlRequestSchema.safeParse({ tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full', path: 'x' }).success).toBe(false)
    expect(AttachmentUrlRequestSchema.safeParse({ tripId: TRIP, entityType: 'wish', entityId: 'e1', variant: 'full', path: 'x' }).success).toBe(false)
    expect(AttachmentUrlRequestSchema.safeParse({ tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'full', url: 'https://x.test' }).success).toBe(false)
    expect(AttachmentUrlRequestSchema.safeParse({ tripId: TRIP, entityType: 'expense', entityId: 'e1', variant: 'thumb' }).success).toBe(false)
  })
})
