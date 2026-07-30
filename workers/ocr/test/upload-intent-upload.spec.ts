import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFirestoreTxMock, type MockReadDoc } from './helpers/tx-mock'

const txGetResponses = new Map<string, MockReadDoc>()
let capturedWritesByTransaction: unknown[][] = []
const operationOrder: string[] = []

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'admin-token'),
  getProjectId:  vi.fn(() => 'demo'),
}))

vi.mock('../src/cascade', async () => {
  const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
  return { ...actual, withTokenRetry: <T>(run: () => Promise<T>) => run() }
})

vi.mock('../src/firestore-tx', () => createFirestoreTxMock({
  get: async path => txGetResponses.get(path) ?? {
    exists: false, fields: {}, name: path, updateTime: null,
  },
  onResult: result => {
    capturedWritesByTransaction.push(result.writes)
    const write = result.writes[0] as {
      op?: string
      document?: string
      fields?: Record<string, unknown> & { status?: { stringValue?: string } }
    } | undefined
    const status = write
      ?.fields?.status?.stringValue
    operationOrder.push(`tx:${status ?? 'read-only'}`)
    const intentPath = `trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`
    if (write?.document?.endsWith(`/documents/${intentPath}`)) {
      if (write.op === 'delete') {
        txGetResponses.delete(intentPath)
      } else if (write.fields) {
        const current = txGetResponses.get(intentPath)
        if (current) txGetResponses.set(intentPath, {
          ...current,
          fields: { ...current.fields, ...write.fields },
        })
      }
    }
  },
}))

vi.mock('../src/r2-storage', () => ({
  createR2Object: vi.fn(),
  headR2Object:   vi.fn(),
  getR2Object:    vi.fn(),
  deleteR2Object: vi.fn(),
}))

import { uploadAttachmentToIntent } from '../src/upload-intent'
import * as r2 from '../src/r2-storage'

const TRIP_ID = 'trip-1'
const INTENT_ID = 'a'.repeat(32)
const UID = 'editor-uid'
const PATH = `trips/${TRIP_ID}/expenses/expense-1/receipt.png`
const DIGEST = '1'.repeat(64)
const OTHER_DIGEST = '2'.repeat(64)
const BYTES = new Uint8Array([1, 2, 3]).buffer
const BUCKET = {} as R2Bucket

function intentDoc(status: 'pending' | 'uploaded' | 'used', digest?: string): MockReadDoc {
  return {
    exists: true,
    name: `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`,
    updateTime: '2026-07-29T00:00:00Z',
    fields: {
      uid:        { stringValue: UID },
      tripId:     { stringValue: TRIP_ID },
      entityType: { stringValue: 'expense' },
      entityId:   { stringValue: 'expense-1' },
      mode:       { stringValue: 'update' },
      kind:       { stringValue: 'full' },
      path:       { stringValue: PATH },
      status:     { stringValue: status },
      expiresAt:  { timestampValue: new Date(Date.now() + 60_000).toISOString() },
      expectedBytes: { integerValue: String(BYTES.byteLength) },
      allowedContentTypes: { arrayValue: { values: [{ stringValue: 'image/png' }] } },
      ...(digest ? { sha256: { stringValue: digest } } : {}),
      customMetadata: { mapValue: { fields: {
        uploadIntentId: { stringValue: INTENT_ID },
        uploaderUid:    { stringValue: UID },
        tripId:         { stringValue: TRIP_ID },
        entityType:     { stringValue: 'expense' },
        entityId:       { stringValue: 'expense-1' },
        kind:           { stringValue: 'full' },
        schemaVersion:  { stringValue: 'v1' },
      } } },
    },
  }
}

function tripDoc(deleting = false): MockReadDoc {
  return {
    exists: true,
    name: `projects/demo/databases/(default)/documents/trips/${TRIP_ID}`,
    updateTime: '2026-07-29T00:00:00Z',
    fields: deleting ? { deletingAt: { timestampValue: '2026-07-29T00:00:00Z' } } : {},
  }
}

function memberDoc(role: 'owner' | 'editor' | 'viewer', removing = false): MockReadDoc {
  return {
    exists: true,
    name: `projects/demo/databases/(default)/documents/trips/${TRIP_ID}/members/${UID}`,
    updateTime: '2026-07-29T00:00:00Z',
    fields: {
      role: { stringValue: role },
      ...(removing ? { removingAt: { timestampValue: '2026-07-29T00:00:00Z' } } : {}),
    },
  }
}

function storedObject(digest = DIGEST) {
  return {
    key: PATH, version: 'v1', size: BYTES.byteLength,
    uploaded: new Date(), contentType: 'image/png',
    customMetadata: { sha256: digest },
  }
}

function run(sha256 = DIGEST) {
  return uploadAttachmentToIntent(
    UID,
    { tripId: TRIP_ID, intentId: INTENT_ID, contentType: 'image/png', bytes: BYTES, sha256 },
    '{}',
    BUCKET,
  )
}

beforeEach(() => {
  txGetResponses.clear()
  txGetResponses.set(`trips/${TRIP_ID}`, tripDoc())
  txGetResponses.set(`trips/${TRIP_ID}/members/${UID}`, memberDoc('editor'))
  capturedWritesByTransaction = []
  operationOrder.length = 0
  vi.mocked(r2.createR2Object).mockReset()
  vi.mocked(r2.createR2Object).mockImplementation(async () => {
    operationOrder.push('r2:put')
    return storedObject()
  })
  vi.mocked(r2.headR2Object).mockReset()
  vi.mocked(r2.headR2Object).mockResolvedValue(storedObject())
  vi.mocked(r2.deleteR2Object).mockReset()
  vi.mocked(r2.deleteR2Object).mockResolvedValue(undefined)
})

describe('intent-bound R2 upload idempotency', () => {
  it('creates the canonical object and advances pending to uploaded', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    await expect(run()).resolves.toEqual({ path: PATH, replayed: false })
    expect(capturedWritesByTransaction).toHaveLength(2)
    expect(capturedWritesByTransaction[0]?.[0]).toMatchObject({
      fields: { status: { stringValue: 'pending' }, sha256: { stringValue: DIGEST } },
      currentDocument: { exists: true },
    })
    expect(capturedWritesByTransaction[1]?.[0]).toMatchObject({
      fields: { status: { stringValue: 'uploaded' }, sha256: { stringValue: DIGEST } },
      currentDocument: { exists: true },
    })
    expect(operationOrder).toEqual(['tx:pending', 'r2:put', 'tx:uploaded'])
  })

  it('replays an already-uploaded intent only when the digest matches', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('uploaded', DIGEST))
    vi.mocked(r2.headR2Object).mockResolvedValue(storedObject())

    await expect(run()).resolves.toEqual({ path: PATH, replayed: true })
    expect(r2.headR2Object).toHaveBeenCalledWith(BUCKET, PATH)
    expect(r2.createR2Object).not.toHaveBeenCalled()
    expect(capturedWritesByTransaction).toEqual([[]])
  })

  it('recreates a missing object for an unexpired uploaded intent', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('uploaded', DIGEST))
    vi.mocked(r2.headR2Object)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(storedObject())
    await expect(run()).resolves.toEqual({ path: PATH, replayed: true })
    expect(r2.createR2Object).toHaveBeenCalledTimes(1)
    expect(capturedWritesByTransaction).toHaveLength(2)
    expect(capturedWritesByTransaction[0]?.[0]).toMatchObject({
      fields: { status: { stringValue: 'pending' }, sha256: { stringValue: DIGEST } },
    })
    expect(capturedWritesByTransaction[1]?.[0]).toMatchObject({
      fields: { status: { stringValue: 'uploaded' }, sha256: { stringValue: DIGEST } },
    })
  })

  it('rejects a replay with different bytes', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('uploaded', DIGEST))

    await expect(run(OTHER_DIGEST)).rejects.toMatchObject({ status: 409 })
    expect(r2.createR2Object).not.toHaveBeenCalled()
  })

  it('accepts a concurrent create winner only when R2 metadata matches', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    vi.mocked(r2.createR2Object).mockResolvedValue(null)
    vi.mocked(r2.headR2Object).mockResolvedValue(storedObject())

    await expect(run()).resolves.toEqual({ path: PATH, replayed: true })
  })

  it('rejects a canonical-path conflict with a different digest', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    vi.mocked(r2.createR2Object).mockResolvedValue(null)
    vi.mocked(r2.headR2Object).mockResolvedValue(storedObject(OTHER_DIGEST))

    await expect(run()).rejects.toMatchObject({ status: 409 })
  })

  it('revalidates role before R2 persistence when an editor was demoted after minting', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    txGetResponses.set(`trips/${TRIP_ID}/members/${UID}`, memberDoc('viewer'))

    await expect(run()).rejects.toMatchObject({ status: 403 })
    expect(r2.createR2Object).not.toHaveBeenCalled()
  })

  it('rejects a member whose removal is in progress before R2 persistence', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    txGetResponses.set(`trips/${TRIP_ID}/members/${UID}`, memberDoc('editor', true))

    await expect(run()).rejects.toMatchObject({ status: 403 })
    expect(r2.createR2Object).not.toHaveBeenCalled()
  })

  it('rejects an upload after trip deletion starts before R2 persistence', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    txGetResponses.set(`trips/${TRIP_ID}`, tripDoc(true))

    await expect(run()).rejects.toMatchObject({ status: 410 })
    expect(r2.createR2Object).not.toHaveBeenCalled()
  })

  it('revalidates after R2 put and compensates when authorization is revoked mid-request', async () => {
    txGetResponses.set(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`, intentDoc('pending'))
    vi.mocked(r2.createR2Object).mockImplementationOnce(async () => {
      operationOrder.push('r2:put')
      txGetResponses.set(`trips/${TRIP_ID}/members/${UID}`, memberDoc('viewer'))
      return storedObject()
    })

    await expect(run()).rejects.toMatchObject({ status: 403 })
    expect(r2.deleteR2Object).toHaveBeenCalledWith(BUCKET, PATH)
    expect(txGetResponses.has(`trips/${TRIP_ID}/uploadIntents/${INTENT_ID}`)).toBe(false)
  })
})
