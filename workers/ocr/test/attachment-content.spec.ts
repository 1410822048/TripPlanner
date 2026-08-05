import { beforeEach, describe, expect, it, vi } from 'vitest'

const { docFields, uploadMock, getObjectMock, deleteObjectMock } = vi.hoisted(() => ({
  docFields: new Map<string, Record<string, unknown> | null>(),
  uploadMock: vi.fn(),
  getObjectMock: vi.fn(),
  deleteObjectMock: vi.fn(async () => undefined),
}))

vi.mock('../src/admin', () => ({
  getAdminToken: vi.fn(async () => 'admin-token'),
  getProjectId:  vi.fn(() => 'demo'),
}))

vi.mock('../src/firestore', async () => {
  const actual = await vi.importActual<typeof import('../src/firestore')>('../src/firestore')
  return {
    ...actual,
    getDocFields: vi.fn(async (_token: string, _project: string, path: string) =>
      docFields.get(path) ?? null),
  }
})

vi.mock('../src/cascade', async () => {
  const actual = await vi.importActual<typeof import('../src/cascade')>('../src/cascade')
  return { ...actual, withTokenRetry: <T>(run: () => Promise<T>) => run() }
})

vi.mock('../src/upload-intent', async () => {
  const actual = await vi.importActual<typeof import('../src/upload-intent')>('../src/upload-intent')
  return { ...actual, uploadAttachmentToIntent: uploadMock }
})
vi.mock('../src/r2-storage', () => ({
  getR2Object:    getObjectMock,
  deleteR2Object: deleteObjectMock,
}))

import {
  handleAttachmentContent,
  handleAttachmentDelete,
  handleAttachmentUpload,
} from '../src/attachment-content'
import { TxCommitAmbiguous, TxRetryExhausted } from '../src/firestore-tx'

const TRIP_ID = 'trip-1'
const EXPENSE_PATH = `trips/${TRIP_ID}/expenses/expense-1/receipt.png`
const WISH_PATH = `trips/${TRIP_ID}/wishes/wish-1/full.png`
const UID = 'viewer-uid'
const INTENT_ID = 'a'.repeat(32)
const CORS = { 'Access-Control-Allow-Origin': 'https://example.test' }
const ENV = { FIREBASE_SERVICE_ACCOUNT: '{}', ATTACHMENTS: {} as R2Bucket }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function seedMembership(
  role: 'owner' | 'editor' | 'viewer' = 'viewer',
  options: { deleting?: boolean; removing?: boolean } = {},
): void {
  docFields.set(`trips/${TRIP_ID}`, {
    ownerId: { stringValue: 'owner-uid' },
    ...(options.deleting ? { deletingAt: { timestampValue: '2026-07-29T00:00:00Z' } } : {}),
  })
  docFields.set(`trips/${TRIP_ID}/members/${UID}`, {
    role: { stringValue: role },
    ...(options.removing ? { removingAt: { timestampValue: '2026-07-29T00:00:00Z' } } : {}),
  })
}

function uploadRequest(bytes: Uint8Array, contentType = 'image/png'): Request {
  return new Request(
    `https://worker.test/attachment-upload?tripId=${TRIP_ID}&intentId=${INTENT_ID}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    },
  )
}

function contentRequest(path = EXPENSE_PATH): Request {
  return new Request('https://worker.test/attachment-content', {
    headers: {
      'X-Attachment-Trip-Id': TRIP_ID,
      'X-Attachment-Path': path,
    },
  })
}

beforeEach(() => {
  docFields.clear()
  uploadMock.mockReset()
  getObjectMock.mockReset()
  deleteObjectMock.mockReset()
  deleteObjectMock.mockResolvedValue(undefined)
})

describe('attachment upload proxy', () => {
  it('rejects MIME spoofing before storing bytes', async () => {
    const response = await handleAttachmentUpload({
      request: uploadRequest(new Uint8Array([1, 2, 3]), 'image/png'),
      uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(415)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('passes validated bytes and SHA-256 to the intent-bound uploader', async () => {
    uploadMock.mockResolvedValue({ path: EXPENSE_PATH, replayed: false })
    const response = await handleAttachmentUpload({
      request: uploadRequest(PNG), uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(200)
    expect(uploadMock).toHaveBeenCalledOnce()
    const input = uploadMock.mock.calls[0]![1] as {
      contentType: string; bytes: ArrayBuffer; sha256: string
    }
    expect(input.contentType).toBe('image/png')
    expect(new Uint8Array(input.bytes)).toEqual(PNG)
    expect(input.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects bodies above 5 MB from Content-Length without reading them', async () => {
    const request = uploadRequest(PNG)
    request.headers.set('Content-Length', String(5 * 1024 * 1024 + 1))
    const response = await handleAttachmentUpload({ request, uid: UID, cors: CORS, env: ENV })

    expect(response.status).toBe(413)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('maps definitive transaction retry exhaustion to 409', async () => {
    uploadMock.mockRejectedValueOnce(new TxRetryExhausted(5, new Error('contention')))

    const response = await handleAttachmentUpload({
      request: uploadRequest(PNG), uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: '伺服器忙碌，請稍後再試',
      code:  'TX_RETRY_EXHAUSTED',
    })
  })

  it('keeps commit-response loss ambiguous as 500', async () => {
    uploadMock.mockRejectedValueOnce(new TxCommitAmbiguous(new Error('commit timed out')))

    const response = await handleAttachmentUpload({
      request: uploadRequest(PNG), uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(500)
  })
})

describe('attachment content proxy', () => {
  it('authorizes membership and streams private bytes without a bearer URL', async () => {
    seedMembership()
    getObjectMock.mockResolvedValue({
      size: PNG.byteLength,
      body: new ReadableStream({ start(controller) { controller.enqueue(PNG); controller.close() } }),
      writeHttpMetadata(headers: Headers) { headers.set('Content-Type', 'image/png') },
    })

    const response = await handleAttachmentContent({
      request: contentRequest(),
      uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.has('ETag')).toBe(false)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG)
  })

  it('fails closed for a non-member before touching R2', async () => {
    docFields.set(`trips/${TRIP_ID}`, { ownerId: { stringValue: 'owner-uid' } })
    const response = await handleAttachmentContent({
      request: contentRequest(),
      uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(403)
    expect(getObjectMock).not.toHaveBeenCalled()
  })

  it('rejects query locators so attachment paths stay out of access logs', async () => {
    seedMembership()
    const request = new Request(
      `https://worker.test/attachment-content?tripId=${TRIP_ID}&path=${encodeURIComponent(EXPENSE_PATH)}`,
    )

    const response = await handleAttachmentContent({ request, uid: UID, cors: CORS, env: ENV })

    expect(response.status).toBe(400)
    expect(getObjectMock).not.toHaveBeenCalled()
  })
})

describe('attachment delete proxy', () => {
  it('rejects an expense delete from a viewer', async () => {
    seedMembership('viewer')
    const response = await handleAttachmentDelete({
      body: { tripId: TRIP_ID, path: EXPENSE_PATH }, uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(403)
    expect(deleteObjectMock).not.toHaveBeenCalled()
  })

  it('allows the wish proposer to delete their attachment', async () => {
    seedMembership('viewer')
    docFields.set(`trips/${TRIP_ID}/wishes/wish-1`, { proposedBy: { stringValue: UID } })
    const response = await handleAttachmentDelete({
      body: { tripId: TRIP_ID, path: WISH_PATH }, uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(200)
    expect(deleteObjectMock).toHaveBeenCalledWith(ENV.ATTACHMENTS, WISH_PATH)
  })

  it('rejects delete while the member removal workflow is in progress', async () => {
    seedMembership('editor', { removing: true })
    const response = await handleAttachmentDelete({
      body: { tripId: TRIP_ID, path: EXPENSE_PATH }, uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(403)
    expect(deleteObjectMock).not.toHaveBeenCalled()
  })

  it('rejects delete after trip cascade deletion starts', async () => {
    seedMembership('editor', { deleting: true })
    const response = await handleAttachmentDelete({
      body: { tripId: TRIP_ID, path: EXPENSE_PATH }, uid: UID, cors: CORS, env: ENV,
    })

    expect(response.status).toBe(410)
    expect(deleteObjectMock).not.toHaveBeenCalled()
  })

  // Deleting an attachment mutates its entity, so it has to clear the same
  // gates the entity's write path does — otherwise this endpoint is simply
  // the way around them, and irreversibly so.
  describe('mirrors the entity write gates', () => {
    const lockedExpense = {
      settlementLockIds: { arrayValue: { values: [{ stringValue: 'settlement-1' }] } },
    }

    it('refuses an editor deleting the receipt of a settled expense', async () => {
      seedMembership('editor')
      docFields.set(`trips/${TRIP_ID}/expenses/expense-1`, lockedExpense)

      const response = await handleAttachmentDelete({
        body: { tripId: TRIP_ID, path: EXPENSE_PATH }, uid: UID, cors: CORS, env: ENV,
      })

      // /expense-update already refuses this editor; without the mirror the
      // receipt dies while Firestore keeps pointing at it, and repairing
      // the doc is exactly what the lock forbids them.
      expect(response.status).toBe(403)
      expect(deleteObjectMock).not.toHaveBeenCalled()
    })

    it('still lets the trip owner delete it', async () => {
      docFields.set(`trips/${TRIP_ID}`, { ownerId: { stringValue: UID } })
      docFields.set(`trips/${TRIP_ID}/members/${UID}`, { role: { stringValue: 'owner' } })
      docFields.set(`trips/${TRIP_ID}/expenses/expense-1`, lockedExpense)

      const response = await handleAttachmentDelete({
        body: { tripId: TRIP_ID, path: EXPENSE_PATH }, uid: UID, cors: CORS, env: ENV,
      })

      expect(response.status).toBe(200)
      expect(deleteObjectMock).toHaveBeenCalledWith(ENV.ATTACHMENTS, EXPENSE_PATH)
    })

    it('leaves an unsettled expense alone', async () => {
      seedMembership('editor')
      docFields.set(`trips/${TRIP_ID}/expenses/expense-1`, {})

      const response = await handleAttachmentDelete({
        body: { tripId: TRIP_ID, path: EXPENSE_PATH }, uid: UID, cors: CORS, env: ENV,
      })

      expect(response.status).toBe(200)
    })

    it('refuses the proposer once the wish voting deadline has passed', async () => {
      seedMembership('viewer')
      docFields.set(`trips/${TRIP_ID}`, {
        ownerId: { stringValue: 'owner-uid' },
        wishVotingDeadlineAt: { timestampValue: '2020-01-01T00:00:00Z' },
      })
      docFields.set(`trips/${TRIP_ID}/wishes/wish-1`, { proposedBy: { stringValue: UID } })

      const response = await handleAttachmentDelete({
        body: { tripId: TRIP_ID, path: WISH_PATH }, uid: UID, cors: CORS, env: ENV,
      })

      expect(response.status).toBe(403)
      expect(deleteObjectMock).not.toHaveBeenCalled()
    })

    it('refuses the trip OWNER too once the deadline has passed', async () => {
      docFields.set(`trips/${TRIP_ID}`, {
        ownerId: { stringValue: UID },
        wishVotingDeadlineAt: { timestampValue: '2020-01-01T00:00:00Z' },
      })
      docFields.set(`trips/${TRIP_ID}/members/${UID}`, { role: { stringValue: 'owner' } })

      const response = await handleAttachmentDelete({
        body: { tripId: TRIP_ID, path: WISH_PATH }, uid: UID, cors: CORS, env: ENV,
      })

      // firestore.rules gates wish delete on wishVotingOpen with no owner
      // exemption, so the owner short-circuit must sit behind the deadline.
      expect(response.status).toBe(403)
      expect(deleteObjectMock).not.toHaveBeenCalled()
    })

    it('allows the proposer while voting is still open', async () => {
      seedMembership('viewer')
      docFields.set(`trips/${TRIP_ID}`, {
        ownerId: { stringValue: 'owner-uid' },
        wishVotingDeadlineAt: { timestampValue: '2099-01-01T00:00:00Z' },
      })
      docFields.set(`trips/${TRIP_ID}/wishes/wish-1`, { proposedBy: { stringValue: UID } })

      const response = await handleAttachmentDelete({
        body: { tripId: TRIP_ID, path: WISH_PATH }, uid: UID, cors: CORS, env: ENV,
      })

      expect(response.status).toBe(200)
    })
  })
})
