import { z } from 'zod'
import { getAdminToken, getProjectId } from './admin'
import { CascadeError, withTokenRetry } from './cascade'
import { getDocFields, readString } from './firestore'
import { expenseIsSettlementLocked } from './expense-write'
import { runFirestoreTransaction, TxRetryExhausted, type TxWrite } from './firestore-tx'
import { requireTripAccess } from './membership-shared'
import { referencedPaths } from './orphan-purge'
import { TripIdRe } from './field-validation'
import { deleteR2Object, getR2Object } from './r2-storage'
import { MAX_ATTACHMENT_BYTES, uploadAttachmentToIntent } from './upload-intent'
import { json, TX_RETRY_EXHAUSTED_MESSAGE, uidTag } from './route-dispatch'
import { serializeErrorChain, type ReportWorkerError } from './sentry'

const IntentIdRe = /^[a-f0-9]{32}$/
export const ATTACHMENT_TRIP_HEADER = 'X-Attachment-Trip-Id'
export const ATTACHMENT_PATH_HEADER = 'X-Attachment-Path'

const AttachmentLocatorSchema = z.object({
  tripId: z.string().regex(TripIdRe),
  path:   z.string().min(1).max(500),
}).strict()

const AttachmentUploadLocatorSchema = z.object({
  tripId:   z.string().regex(TripIdRe),
  intentId: z.string().regex(IntentIdRe),
}).strict()

export const AttachmentDeleteRequestSchema = AttachmentLocatorSchema

type AttachmentCollection = 'expenses' | 'bookings' | 'wishes'

interface ParsedAttachmentPath {
  collection: AttachmentCollection
  entityId:   string
}

interface AttachmentArgs {
  uid: string
  cors: Record<string, string>
  traceId?: string
  env: { FIREBASE_SERVICE_ACCOUNT: string; ATTACHMENTS: R2Bucket }
  /** Same contract as handleJsonRoute's: the generic-500 branch here is
   *  the other place an unexpected failure would otherwise stay inside
   *  the Worker. */
  report: ReportWorkerError
}

function parseAttachmentPath(path: string, tripId: string): ParsedAttachmentPath {
  const parts = path.split('/')
  if (
    parts.length !== 5
    || parts[0] !== 'trips'
    || parts[1] !== tripId
    || !TripIdRe.test(parts[3] ?? '')
    || !(parts[2] === 'expenses' || parts[2] === 'bookings' || parts[2] === 'wishes')
    || !parts[4]
    || parts[4].includes('..')
  ) {
    throw new CascadeError(400, 'invalid attachment path')
  }
  return { collection: parts[2], entityId: parts[3] }
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries())
}

function attachmentLocator(request: Request): Record<string, string> {
  return {
    tripId: request.headers.get(ATTACHMENT_TRIP_HEADER) ?? '',
    path:   request.headers.get(ATTACHMENT_PATH_HEADER) ?? '',
  }
}

async function readBoundedBody(request: Request): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size <= 0) throw new CascadeError(400, 'invalid Content-Length')
    if (size > MAX_ATTACHMENT_BYTES) throw new CascadeError(413, 'attachment exceeds 5 MB')
  }
  if (!request.body) throw new CascadeError(400, 'attachment body is required')

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ATTACHMENT_BYTES) {
        await reader.cancel('attachment exceeds byte limit')
        throw new CascadeError(413, 'attachment exceeds 5 MB')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new CascadeError(400, 'attachment body is empty')
  if (declared !== null && total !== Number(declared)) {
    throw new CascadeError(400, 'attachment length does not match Content-Length')
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length))
}

function assertMagicBytes(contentType: string, buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer)
  let valid = false
  if (contentType === 'image/jpeg') {
    valid = startsWith(bytes, [0xff, 0xd8, 0xff])
  } else if (contentType === 'image/png') {
    valid = startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  } else if (contentType === 'image/webp') {
    valid = ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
  } else if (contentType === 'application/pdf') {
    valid = ascii(bytes, 0, 5) === '%PDF-'
  } else if (contentType === 'image/heic' || contentType === 'image/heif') {
    const header = ascii(bytes, 4, Math.min(28, Math.max(0, bytes.length - 4)))
    valid = header.startsWith('ftyp') && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']
      .some(brand => header.includes(brand))
  }
  if (!valid) throw new CascadeError(415, `file signature does not match ${contentType}`)
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Thumbnail / file reads. Deliberately ONE member-doc GET, not the shared
 *  readTripAccess (trip + member): this is the hottest endpoint (one call
 *  per thumbnail, 600/min) and a deleting trip's blobs are about to go
 *  anyway. Membership and removingAt are what keep a removed user out. */
async function requireTripMember(
  callerUid:          string,
  tripId:             string,
  serviceAccountJson: string,
): Promise<{ role: string | undefined }> {
  return withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId = getProjectId(serviceAccountJson)
    const member = await getDocFields(
      accessToken, projectId, `trips/${tripId}/members/${callerUid}`,
    )
    if (!member) throw new CascadeError(403, 'caller is not a trip member')
    if ('removingAt' in member) throw new CascadeError(403, 'caller is being removed from the trip')
    return { role: readString(member, 'role') }
  })
}

/**
 * Cleanup must clear the entity's write gates and prove it no longer
 * references the object. Without that this
 * endpoint becomes the way around them: an editor who cannot edit a
 * settled expense could still destroy its receipt, and a proposer frozen
 * out by the voting deadline could still destroy their wish's image —
 * irreversibly, since repairing the doc afterwards is exactly what those
 * gates forbid.
 */
async function authorizeDelete(
  callerUid:          string,
  tripId:             string,
  parsed:             ParsedAttachmentPath,
  path:               string,
  serviceAccountJson: string,
): Promise<void> {
  await withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId = getProjectId(serviceAccountJson)
    await runFirestoreTransaction(accessToken, projectId, async tx => {
      // Wishes: any member, until voting closes. Expenses / bookings: the
      // roles that may edit them.
      const { isOwner } = await requireTripAccess(tx, tripId, callerUid, parsed.collection === 'wishes'
        ? { wishVotingOpen: true }
        : { roles: ['owner', 'editor'] })
      const entity = await tx.get(`trips/${tripId}/${parsed.collection}/${parsed.entityId}`)
      if (parsed.collection === 'wishes') {
        if (!isOwner) {
          if (!entity.exists) throw new CascadeError(404, 'wish not found')
          if (readString(entity.fields, 'proposedBy') !== callerUid) {
            throw new CascadeError(403, 'only the wish proposer or trip owner may delete this attachment')
          }
        }
      } else {
        if (parsed.collection === 'expenses' && !isOwner) {
          if (!entity.exists) throw new CascadeError(404, 'expense not found')
          if (expenseIsSettlementLocked(entity.fields)) {
            throw new CascadeError(403, 'only the trip owner may delete this attachment after the expense has been settled')
          }
        }
      }
      // Cleanup 只能刪已脫離實體引用的物件；包含 soft-delete 保留期內的收據。
      if (referencedPaths(parsed.collection, entity.fields).has(path)) {
        throw new CascadeError(409, '附件仍被使用，請先透過原項目的編輯流程移除或替換附件')
      }
      const intents = await tx.runQuery({
        parent: `trips/${tripId}`, collection: 'uploadIntents',
        filters: [{ fieldPath: 'path', op: 'EQUAL', value: { stringValue: path } }], limit: 2,
      })
      if (intents.length > 1) throw new CascadeError(409, '附件上傳紀錄異常，請稍後重試')
      const writes: TxWrite[] = []
      for (const intent of intents) {
        if (readString(intent.fields, 'status') === 'used') continue
        if (!isOwner && readString(intent.fields, 'uid') !== callerUid) {
          throw new CascadeError(403, '只有上傳者或旅程擁有者可以取消尚未使用的附件')
        }
        // 同一交易撤銷尚未消耗的 intent；consume 或 upload 的 concurrent
        // commit 必須重試，不能在 R2 清理後重新綁定已刪路徑。
        writes.push({ op: 'delete', document: intent.name, currentDocument: { exists: true } })
      }
      // used intent 不可重用；無 intent 的舊路徑也不能透過 Worker 重新綁定。
      // R2 side effect 留在交易外，不會隨 Firestore contention 重跑。
      return { writes, result: undefined }
    })
  })
}

async function dispatchAttachment<T>(args: {
  endpoint: string
  uid: string
  cors: Record<string, string>
  traceId?: string
  report: ReportWorkerError
  run: () => Promise<T>
  respond: (result: T) => Response
}): Promise<Response> {
  const trace = args.traceId ? ` trace=${args.traceId}` : ''
  try {
    const result = await args.run()
    console.log(`[${args.endpoint}] uid=${uidTag(args.uid)} ok${trace}`)
    return args.respond(result)
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.warn(`[${args.endpoint}] invalid request${trace}`)
      return json({ error: 'Invalid request', detail: error.message }, 400, args.cors)
    }
    // Transaction retry exhaustion is definitively pre-commit for Firestore.
    // A create-only R2 object may already exist before the finalize tx; the
    // expired-intent + storage-scan path reconciles that orphan. Returning a
    // 409 lets the client roll back immediately instead of re-uploading the
    // entire attachment and temporarily retaining a phantom optimistic row.
    // TxCommitAmbiguous deliberately remains a generic 500 below.
    if (error instanceof TxRetryExhausted) {
      console.warn(`[${args.endpoint}] tx-retry-exhausted: ${error.message}${trace}`)
      return json(
        { error: TX_RETRY_EXHAUSTED_MESSAGE, code: 'TX_RETRY_EXHAUSTED' },
        409,
        args.cors,
      )
    }
    if (error instanceof CascadeError) {
      console.warn(`[${args.endpoint}] ${error.status} ${error.message}${trace}`)
      return json({ error: error.message }, error.status, args.cors)
    }
    const err = error instanceof Error ? error : new Error(String(error))
    console.error(`[${args.endpoint}] internal error: ${err.message}${trace}`)
    args.report(`[${args.endpoint}] ${err.message}`, { error: serializeErrorChain(err) })
    return json({ error: 'Internal error' }, 500, args.cors)
  }
}

export function handleAttachmentUpload(
  args: AttachmentArgs & { request: Request },
): Promise<Response> {
  return dispatchAttachment({
    endpoint: 'attachment-upload', uid: args.uid, cors: args.cors, traceId: args.traceId, report: args.report,
    run: async () => {
      const locator = AttachmentUploadLocatorSchema.parse(queryObject(new URL(args.request.url)))
      const contentType = args.request.headers.get('content-type')?.split(';', 1)[0]?.trim()
      if (!contentType) throw new CascadeError(415, 'Content-Type is required')
      const bytes = await readBoundedBody(args.request)
      assertMagicBytes(contentType, bytes)
      return uploadAttachmentToIntent(
        args.uid,
        { ...locator, contentType, bytes, sha256: await sha256Hex(bytes) },
        args.env.FIREBASE_SERVICE_ACCOUNT,
        args.env.ATTACHMENTS,
      )
    },
    respond: result => json(result, 200, args.cors),
  })
}

export function handleAttachmentContent(
  args: AttachmentArgs & { request: Request },
): Promise<Response> {
  return dispatchAttachment({
    endpoint: 'attachment-content', uid: args.uid, cors: args.cors, traceId: args.traceId, report: args.report,
    run: async () => {
      const locator = AttachmentLocatorSchema.parse(attachmentLocator(args.request))
      parseAttachmentPath(locator.path, locator.tripId)
      await requireTripMember(args.uid, locator.tripId, args.env.FIREBASE_SERVICE_ACCOUNT)
      const object = await getR2Object(args.env.ATTACHMENTS, locator.path)
      if (!object) throw new CascadeError(404, 'attachment not found')
      if (object.size > MAX_ATTACHMENT_BYTES) throw new CascadeError(413, 'stored attachment exceeds size limit')
      return object
    },
    respond: object => {
      const headers = new Headers(args.cors)
      object.writeHttpMetadata(headers)
      headers.set('Content-Length', String(object.size))
      headers.set('Cache-Control', 'private, no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(object.body, { status: 200, headers })
    },
  })
}

export function handleAttachmentDelete(
  args: AttachmentArgs & { body: unknown },
): Promise<Response> {
  return dispatchAttachment({
    endpoint: 'attachment-delete', uid: args.uid, cors: args.cors, traceId: args.traceId, report: args.report,
    run: async () => {
      const locator = AttachmentDeleteRequestSchema.parse(args.body)
      const parsed = parseAttachmentPath(locator.path, locator.tripId)
      await authorizeDelete(args.uid, locator.tripId, parsed, locator.path, args.env.FIREBASE_SERVICE_ACCOUNT)
      await deleteR2Object(args.env.ATTACHMENTS, locator.path)
      return { ok: true as const }
    },
    respond: result => json(result, 200, args.cors),
  })
}
