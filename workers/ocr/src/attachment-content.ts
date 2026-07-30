import { z } from 'zod'
import { getAdminToken, getProjectId } from './admin'
import { CascadeError, withTokenRetry } from './cascade'
import { getDocFields, readString } from './firestore'
import { TxRetryExhausted } from './firestore-tx'
import { TripIdRe } from './field-validation'
import { deleteR2Object, getR2Object } from './r2-storage'
import { uploadAttachmentToIntent } from './upload-intent'
import { json, TX_RETRY_EXHAUSTED_MESSAGE, uidTag } from './route-dispatch'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
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

async function requireActiveTripMember(
  callerUid:          string,
  tripId:             string,
  serviceAccountJson: string,
): Promise<{ role: string | undefined; isOwner: boolean }> {
  return withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId = getProjectId(serviceAccountJson)
    const [trip, member] = await Promise.all([
      getDocFields(accessToken, projectId, `trips/${tripId}`),
      getDocFields(accessToken, projectId, `trips/${tripId}/members/${callerUid}`),
    ])
    if (!trip) throw new CascadeError(404, 'trip not found')
    if ('deletingAt' in trip) throw new CascadeError(410, 'trip is being deleted')
    if (!member) throw new CascadeError(403, 'caller is not a trip member')
    if ('removingAt' in member) throw new CascadeError(403, 'caller is being removed from the trip')
    return { role: readString(member, 'role'), isOwner: readString(trip, 'ownerId') === callerUid }
  })
}

async function authorizeDelete(
  callerUid:          string,
  tripId:             string,
  parsed:             ParsedAttachmentPath,
  serviceAccountJson: string,
): Promise<void> {
  const membership = await requireActiveTripMember(callerUid, tripId, serviceAccountJson)
  if (parsed.collection !== 'wishes') {
    if (membership.role !== 'owner' && membership.role !== 'editor') {
      throw new CascadeError(403, 'caller cannot delete this attachment')
    }
    return
  }
  if (membership.isOwner) return

  await withTokenRetry(async () => {
    const accessToken = await getAdminToken(serviceAccountJson)
    const projectId = getProjectId(serviceAccountJson)
    const wish = await getDocFields(
      accessToken, projectId, `trips/${tripId}/wishes/${parsed.entityId}`,
    )
    if (!wish) throw new CascadeError(404, 'wish not found')
    if (readString(wish, 'proposedBy') !== callerUid) {
      throw new CascadeError(403, 'only the wish proposer or trip owner may delete this attachment')
    }
  })
}

async function dispatchAttachment<T>(args: {
  endpoint: string
  uid: string
  cors: Record<string, string>
  traceId?: string
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
    console.error(`[${args.endpoint}] internal error: ${(error as Error).message}${trace}`)
    return json({ error: 'Internal error' }, 500, args.cors)
  }
}

export function handleAttachmentUpload(
  args: AttachmentArgs & { request: Request },
): Promise<Response> {
  return dispatchAttachment({
    endpoint: 'attachment-upload', uid: args.uid, cors: args.cors, traceId: args.traceId,
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
    endpoint: 'attachment-content', uid: args.uid, cors: args.cors, traceId: args.traceId,
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
    endpoint: 'attachment-delete', uid: args.uid, cors: args.cors, traceId: args.traceId,
    run: async () => {
      const locator = AttachmentDeleteRequestSchema.parse(args.body)
      const parsed = parseAttachmentPath(locator.path, locator.tripId)
      await authorizeDelete(args.uid, locator.tripId, parsed, args.env.FIREBASE_SERVICE_ACCOUNT)
      await deleteR2Object(args.env.ATTACHMENTS, locator.path)
      return { ok: true as const }
    },
    respond: result => json(result, 200, args.cors),
  })
}
