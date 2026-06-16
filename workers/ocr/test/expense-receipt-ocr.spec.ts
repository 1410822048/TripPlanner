// Tests for /expense-receipt-ocr — the Worker-authoritative "re-OCR an
// EXISTING receipt" endpoint. The security surface (BOLA path, MIME, size,
// settlement-lock ⇒ owner, membership) is the whole point of routing this
// through the server, so it's exercised exhaustively here. All external
// deps (admin token, Firestore reads, Storage, the OCR model) are mocked; the
// REAL expenseIsSettlementLocked + readString run against the fixtures.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { docFields, storageState, ocrCalls } = vi.hoisted(() => ({
  docFields:    new Map<string, Record<string, unknown> | null>(),
  storageState: { meta: null as unknown, bytes: null as unknown, metaThrows: false, bytesThrows: false },
  ocrCalls:     [] as Array<{ mimeType: string; currency?: string }>,
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

vi.mock('../src/storage', () => ({
  getObjectMetadata: vi.fn(async () => {
    if (storageState.metaThrows) throw new Error('boom')
    return storageState.meta
  }),
  downloadObject: vi.fn(async () => {
    if (storageState.bytesThrows) throw new Error('boom')
    return storageState.bytes
  }),
}))

vi.mock('../src/claude', () => ({
  OCR_PROMPT_VERSION: 'claude-receipt-v3',
  extractReceiptItems: vi.fn(async (_b64: string, mimeType: string, currency: string | undefined) => {
    ocrCalls.push({ mimeType, currency })
    return { items: [{ name: 'コーヒー', amountText: '380' }], adjustments: [], ignoredLines: [], totalText: '380' }
  }),
  OcrError: class OcrError extends Error {
    constructor(message: string, public readonly status: number) { super(message) }
  },
}))

import { expenseReceiptOcr, ExpenseReceiptOcrRequestSchema } from '../src/expense-receipt-ocr'
import { CascadeError } from '../src/cascade'
import { extractReceiptItems } from '../src/claude'

const TRIP = 'trip-1'
const EXP  = 'exp-1'
const CALLER = 'caller-uid'
const RECEIPT_PATH = `trips/${TRIP}/expenses/${EXP}/receipt.webp`

function fields(map: Record<string, unknown>): Record<string, unknown> { return map }
function str(s: string)  { return { stringValue: s } }
function ts(s: string)   { return { timestampValue: s } }

function seedTrip(opts: { ownerId?: string; deletingAt?: boolean } = {}): void {
  const f: Record<string, unknown> = { currency: str('JPY') }
  if (opts.ownerId)    f.ownerId = str(opts.ownerId)
  if (opts.deletingAt) f.deletingAt = ts('2026-06-04T00:00:00Z')
  docFields.set(`trips/${TRIP}`, fields(f))
}
function seedMember(uid: string, role: 'owner' | 'editor' | 'viewer' = 'editor'): void {
  docFields.set(`trips/${TRIP}/members/${uid}`, fields({ role: str(role) }))
}
function seedExpense(opts: {
  receipt?:          { path: string; type: string }
  deletedAt?:        string
  settlementLockIds?: string[]
  updatedAt?:        string
} = {}): void {
  const f: Record<string, unknown> = {}
  if (opts.receipt) {
    f.receipt = { mapValue: { fields: { path: str(opts.receipt.path), type: str(opts.receipt.type), url: str('https://x') } } }
  }
  if (opts.deletedAt) f.deletedAt = ts(opts.deletedAt)
  if (opts.settlementLockIds) {
    f.settlementLockIds = { arrayValue: { values: opts.settlementLockIds.map(str) } }
  }
  if (opts.updatedAt) f.updatedAt = ts(opts.updatedAt)
  docFields.set(`trips/${TRIP}/expenses/${EXP}`, fields(f))
}
function seedStorageOk(contentType = 'image/webp', size = 1000): void {
  storageState.meta  = { name: RECEIPT_PATH, size, contentType }
  storageState.bytes = { bytes: new ArrayBuffer(size), contentType }
}

function run(reqOverrides: Record<string, unknown> = {}, caller = CALLER) {
  return expenseReceiptOcr(
    caller,
    { tripId: TRIP, expenseId: EXP, ...reqOverrides } as never,
    '{}', 'demo-bucket',
    (image, mimeType, currency) =>
      extractReceiptItems(image, mimeType, currency, { apiKey: 'k', resource: 'aic-claude-eus2', model: 'claude-sonnet-4-6' }),
  )
}

beforeEach(() => {
  docFields.clear()
  storageState.meta = null
  storageState.bytes = null
  storageState.metaThrows = false
  storageState.bytesThrows = false
  ocrCalls.length = 0
  vi.mocked(extractReceiptItems).mockClear()
})

describe('expenseReceiptOcr — happy paths', () => {
  it('editor + unlocked image receipt → result + sourceReceiptPath + expenseUpdatedAt', async () => {
    seedTrip({ ownerId: 'someone-else' })
    seedMember(CALLER, 'editor')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()

    const out = await run()
    expect(out.result.items.length).toBeGreaterThan(0)
    expect(out.sourceReceiptPath).toBe(RECEIPT_PATH)
    expect(out.expenseUpdatedAt).toBe('2026-06-04T08:00:00Z')
    // The OCR core is handed the GCS contentType (authoritative), not a client mime.
    expect(ocrCalls[0].mimeType).toBe('image/webp')
  })

  it('owner + LOCKED image receipt → 200 (owner override)', async () => {
    seedTrip({ ownerId: CALLER })
    seedMember(CALLER, 'editor')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, settlementLockIds: ['s-1'] })
    seedStorageOk()

    const out = await run()
    expect(out.result.items.length).toBeGreaterThan(0)
  })

  it('passes currencyHint through to the OCR core', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER); seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } }); seedStorageOk()
    await run({ currencyHint: 'TWD' })
    expect(ocrCalls[0].currency).toBe('TWD')
  })

  it('re-runs OCR against the stored receipt image', async () => {
    seedTrip({ ownerId: 'x' })
    seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } })
    seedStorageOk()

    await run({ currencyHint: 'TWD' })

    expect(extractReceiptItems).toHaveBeenCalledTimes(1)
  })
})

describe('expenseReceiptOcr — authorization', () => {
  it('non-member → 403', async () => {
    seedTrip({ ownerId: 'x' })
    // no member doc seeded
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } }); seedStorageOk()
    await expect(run()).rejects.toMatchObject({ status: 403 })
  })

  it('viewer role → 403 (mirrors expense-update: needs owner/editor)', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER, 'viewer')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } }); seedStorageOk()
    await expect(run()).rejects.toMatchObject({ status: 403 })
  })

  it('non-owner editor + LOCKED receipt → 403', async () => {
    seedTrip({ ownerId: 'someone-else' }); seedMember(CALLER, 'editor')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, settlementLockIds: ['s-1'] })
    seedStorageOk()
    await expect(run()).rejects.toMatchObject({ status: 403 })
  })

  it('owner check uses trip.ownerId, NOT members.role (drift guard)', async () => {
    // role says owner, but ownerId is someone else → still blocked on a lock.
    seedTrip({ ownerId: 'real-owner' }); seedMember(CALLER, 'owner')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, settlementLockIds: ['s-1'] })
    seedStorageOk()
    await expect(run()).rejects.toMatchObject({ status: 403 })
  })

  it('trip not found → 404 / deletingAt → 410 / expense deleted → 404', async () => {
    // trip missing
    await expect(run()).rejects.toMatchObject({ status: 404 })
    // deletingAt
    seedTrip({ ownerId: 'x', deletingAt: true }); seedMember(CALLER)
    await expect(run()).rejects.toMatchObject({ status: 410 })
    // expense deleted
    seedTrip({ ownerId: 'x' })
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, deletedAt: '2026-06-03T00:00:00Z' })
    await expect(run()).rejects.toMatchObject({ status: 404 })
  })
})

describe('expenseReceiptOcr — receipt + storage validation', () => {
  it('no receipt → 404', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER); seedExpense({})
    await expect(run()).rejects.toMatchObject({ status: 404 })
  })

  it('PDF receipt (non-image type) → 415', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: `trips/${TRIP}/expenses/${EXP}/receipt.pdf`, type: 'application/pdf' } })
    await expect(run()).rejects.toMatchObject({ status: 415 })
  })

  it('HEIC receipt is stored as an attachment but rejected for OCR', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: `trips/${TRIP}/expenses/${EXP}/receipt.heic`, type: 'image/heic' } })
    await expect(run()).rejects.toMatchObject({ status: 415 })
    expect(extractReceiptItems).not.toHaveBeenCalled()
  })

  it('receipt.path not under trips/{tripId}/expenses/{expenseId}/ → 400 (BOLA)', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: 'trips/other-trip/expenses/x/receipt.webp', type: 'image/webp' } })
    await expect(run()).rejects.toMatchObject({ status: 400 })
  })

  it('storage object missing (metadata null) → 404', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } })
    storageState.meta = null  // not found
    await expect(run()).rejects.toMatchObject({ status: 404 })
  })

  it('storage metadata read error → 502', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } })
    storageState.metaThrows = true
    await expect(run()).rejects.toMatchObject({ status: 502 })
  })

  it('oversize object (metadata.size > 5MB) → 413', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } })
    storageState.meta = { name: RECEIPT_PATH, size: 6 * 1024 * 1024, contentType: 'image/webp' }
    await expect(run()).rejects.toMatchObject({ status: 413 })
  })

  it('stored object contentType not image → 415', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } })
    storageState.meta = { name: RECEIPT_PATH, size: 1000, contentType: 'application/octet-stream' }
    await expect(run()).rejects.toMatchObject({ status: 415 })
  })

  it('stored object contentType image but unsupported by OCR provider', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' } })
    storageState.meta = { name: RECEIPT_PATH, size: 1000, contentType: 'image/heif' }
    await expect(run()).rejects.toMatchObject({ status: 415 })
  })
})

describe('expenseReceiptOcr — post-OCR revalidation (mid-OCR race)', () => {
  it('receipt swapped while OCR runs → 409', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()
    // Simulate another client REPLACING the receipt during the OCR call.
    vi.mocked(extractReceiptItems).mockImplementationOnce(async () => {
      seedExpense({ receipt: { path: `trips/${TRIP}/expenses/${EXP}/receipt-v2.webp`, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
      return { items: [{ name: 'x', amountText: '1' }], adjustments: [], ignoredLines: [], totalText: '1' }
    })
    await expect(run()).rejects.toMatchObject({ status: 409 })
  })

  it('expense edited (updatedAt advanced) while OCR runs → 409', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()
    vi.mocked(extractReceiptItems).mockImplementationOnce(async () => {
      seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T09:00:00Z' })
      return { items: [{ name: 'x', amountText: '1' }], adjustments: [], ignoredLines: [], totalText: '1' }
    })
    await expect(run()).rejects.toMatchObject({ status: 409 })
  })

  it('no change during OCR → 200 (post-read matches)', async () => {
    seedTrip({ ownerId: 'x' }); seedMember(CALLER)
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()
    const out = await run()
    expect(out.result.items.length).toBeGreaterThan(0)
    expect(out.expenseUpdatedAt).toBe('2026-06-04T08:00:00Z')
  })

  it('expense becomes settlement-locked (non-owner) while OCR runs → 403', async () => {
    // The whole point of the FULL re-run post-check: someone records 済み
    // mid-OCR → settlementLockIds set, but the lock write does NOT bump
    // updatedAt. A path/updatedAt-only check would PASS and the non-owner's
    // stale draft would only 403 at save. The re-run authorization rejects.
    seedTrip({ ownerId: 'someone-else' }); seedMember(CALLER, 'editor')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()
    vi.mocked(extractReceiptItems).mockImplementationOnce(async () => {
      seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, settlementLockIds: ['s-1'], updatedAt: '2026-06-04T08:00:00Z' })
      return { items: [{ name: 'x', amountText: '1' }], adjustments: [], ignoredLines: [], totalText: '1' }
    })
    await expect(run()).rejects.toMatchObject({ status: 403 })
  })

  it('expense becomes locked mid-OCR but caller is OWNER → 200 (override holds post-OCR)', async () => {
    seedTrip({ ownerId: CALLER }); seedMember(CALLER, 'editor')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()
    vi.mocked(extractReceiptItems).mockImplementationOnce(async () => {
      seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, settlementLockIds: ['s-1'], updatedAt: '2026-06-04T08:00:00Z' })
      return { items: [{ name: 'x', amountText: '1' }], adjustments: [], ignoredLines: [], totalText: '1' }
    })
    const out = await run()
    expect(out.result.items.length).toBeGreaterThan(0)
  })

  it('caller role downgraded to viewer while OCR runs → 403', async () => {
    seedTrip({ ownerId: 'someone-else' }); seedMember(CALLER, 'editor')
    seedExpense({ receipt: { path: RECEIPT_PATH, type: 'image/webp' }, updatedAt: '2026-06-04T08:00:00Z' })
    seedStorageOk()
    vi.mocked(extractReceiptItems).mockImplementationOnce(async () => {
      seedMember(CALLER, 'viewer')
      return { items: [{ name: 'x', amountText: '1' }], adjustments: [], ignoredLines: [], totalText: '1' }
    })
    await expect(run()).rejects.toMatchObject({ status: 403 })
  })
})

describe('ExpenseReceiptOcrRequestSchema — strict', () => {
  it('rejects any client-supplied path / url / receipt', async () => {
    expect(ExpenseReceiptOcrRequestSchema.safeParse({ tripId: TRIP, expenseId: EXP }).success).toBe(true)
    expect(ExpenseReceiptOcrRequestSchema.safeParse({ tripId: TRIP, expenseId: EXP, currencyHint: 'JPY' }).success).toBe(true)
    expect(ExpenseReceiptOcrRequestSchema.safeParse({ tripId: TRIP, expenseId: EXP, cacheMode: 'reuse' }).success).toBe(false)
    expect(ExpenseReceiptOcrRequestSchema.safeParse({ tripId: TRIP, expenseId: EXP, path: 'x' }).success).toBe(false)
    expect(ExpenseReceiptOcrRequestSchema.safeParse({ tripId: TRIP, expenseId: EXP, url: 'https://x' }).success).toBe(false)
    expect(ExpenseReceiptOcrRequestSchema.safeParse({ tripId: TRIP, expenseId: EXP, receipt: {} }).success).toBe(false)
  })
})

// Sanity: the thrown errors are CascadeError so route-dispatch maps them to
// the right status instead of a generic 500.
describe('expenseReceiptOcr — error type', () => {
  it('throws CascadeError (not generic Error) so the route maps the status', async () => {
    await expect(run()).rejects.toBeInstanceOf(CascadeError)
  })
})
