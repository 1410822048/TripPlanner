// workers/ocr/src/expense-receipt-ocr.ts
// Worker-authoritative "re-OCR an EXISTING expense receipt" endpoint.
//
// Why a server route instead of the client re-downloading the receipt
// bytes and re-POSTing to /ocr:
//   - The client never names the object. The Worker reads receipt.path from
//     the Firestore expense doc, so a caller can't path-inject / read an
//     arbitrary Storage object (BOLA defence).
//   - Permission mirrors /expense-update (owner/editor; settlement-locked ⇒
//     owner-only), because the OCR result overwrites the items / amount /
//     splits edit draft — it is "preparing an update", not a plain read.
//   - MIME / size / rate-limit / Gemini cost all collapse to one server
//     boundary instead of being scattered across the front end.
//
// This endpoint is READ-ONLY (no Firestore / Storage write). It returns the
// OCR candidate; the user still confirms in the editable modal and SAVE is
// what actually mutates the expense (via /expense-update).
import { z }                                  from 'zod'
import { getAdminToken, getProjectId }        from './admin'
import { getDocFields, readString }           from './firestore'
import type { FsValue }                       from './firestore'
import { getObjectMetadata, downloadObject }  from './storage'
import { extractReceiptItems }                from './gemini'
import { expenseIsSettlementLocked }          from './expense-write'
import { CascadeError }                       from './cascade'
import type { OcrResponse }                   from './schema'

const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

/** Hard ceiling on the receipt object we'll pull into memory + hand to
 *  Gemini. Mirrors storage.rules' 5MB expense-receipt cap. */
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024

/** Strict request body. ONLY identifiers + a currency hint cross the wire —
 *  the client is NEVER allowed to supply the receipt path (the Worker reads
 *  it from the doc — BOLA defence). `.strict()` rejects any extra key so a
 *  smuggled `path` / `receipt` is a 400, not a silently-ignored field. */
export const ExpenseReceiptOcrRequestSchema = z.object({
  tripId:       z.string().regex(TripIdRe),
  expenseId:    z.string().regex(TripIdRe),
  currencyHint: z.string().regex(/^[A-Z]{3}$/, 'currencyHint must be 3 uppercase letters').optional(),
}).strict()
export type ExpenseReceiptOcrRequest = z.infer<typeof ExpenseReceiptOcrRequestSchema>

export interface ExpenseReceiptOcrResult {
  result:            OcrResponse
  /** The receipt object path the Worker actually OCR'd, read from the doc.
   *  The client compares this against the modal's editTarget.receipt.path to
   *  discard a result for a receipt that was swapped while the call was in
   *  flight. */
  sourceReceiptPath: string
  /** The expense doc's `updatedAt` (RFC3339) at OCR time. The client
   *  discards the result if this differs from the value it captured when it
   *  fired the request (expense edited elsewhere mid-flight). Absent when
   *  the doc carries no parseable updatedAt → client falls back to the
   *  receiptPath + expenseId guard. */
  expenseUpdatedAt?: string
}

/** mapValue → inner fields, or undefined when the field is absent / not a map. */
function readMap(fields: Record<string, FsValue>, key: string): Record<string, FsValue> | undefined {
  return (fields[key] as { mapValue?: { fields?: Record<string, FsValue> } } | undefined)?.mapValue?.fields
}

/** RFC3339 timestampValue, or undefined when absent / not a timestamp. */
function readTimestamp(fields: Record<string, FsValue>, key: string): string | undefined {
  const ts = (fields[key] as { timestampValue?: string } | undefined)?.timestampValue
  return typeof ts === 'string' ? ts : undefined
}

/** Standard chunked ArrayBuffer → base64 (Workers have btoa but it wants a
 *  binary string; spreading the whole array would blow the call stack on a
 *  multi-MB image, so we chunk). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** The mutable authorization + applicability state of a re-OCR target,
 *  resolved from a FRESH read of trip / member / expense. Run twice: once
 *  before OCR (to authorize the caller + locate the receipt) and once after
 *  (to confirm nothing that changes the answer shifted while Gemini ran).
 *
 *  Throws CascadeError for any authz/existence failure (trip/member/expense
 *  gone, role downgraded, settlement-locked for a non-owner, bad receipt) —
 *  so re-running it post-OCR turns a mid-OCR permission loss into a 403/404/
 *  410 instead of a silently-applied stale result. The returned snapshot
 *  ({ receiptPath, updatedAt }) lets the caller detect a swapped receipt /
 *  edited expense (→ 409). */
interface ReceiptOcrSnapshot {
  receiptPath: string
  updatedAt:   string | undefined
}

async function authorizeAndLocateReceipt(
  accessToken: string,
  projectId:   string,
  tripId:      string,
  expenseId:   string,
  callerUid:   string,
): Promise<ReceiptOcrSnapshot> {
  const [tripFields, memberFields, expenseFields] = await Promise.all([
    getDocFields(accessToken, projectId, `trips/${tripId}`),
    getDocFields(accessToken, projectId, `trips/${tripId}/members/${callerUid}`),
    getDocFields(accessToken, projectId, `trips/${tripId}/expenses/${expenseId}`),
  ])

  // ── Authorization (mirror /expense-update: owner/editor) ─────────
  if (!tripFields)                  throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in tripFields)   throw new CascadeError(410, 'trip is being deleted')
  if (!memberFields)                throw new CascadeError(403, 'caller is not a trip member')
  const role = readString(memberFields, 'role')
  if (role !== 'owner' && role !== 'editor') {
    throw new CascadeError(403, 'caller role is not owner/editor')
  }

  if (!expenseFields) throw new CascadeError(404, 'expense not found')
  if (readTimestamp(expenseFields, 'deletedAt')) {
    throw new CascadeError(404, 'expense is deleted')
  }

  // Settlement lock: a locked expense's items/amount/splits are owner-only,
  // and OCR is "preparing an edit", so gate it the same way. Owner is
  // trips/{id}.ownerId (single source of truth — NOT members.role, which
  // can drift; admin SDK bypasses rules so we can't lean on them). The lock
  // write (settlementLockIds) does NOT bump the expense's updatedAt, so this
  // gate is the ONLY thing that catches "settled mid-OCR by someone else" —
  // a path/updatedAt-only post-check would let a non-owner's stale draft
  // through to a save that then 403s.
  const isOwner = readString(tripFields, 'ownerId') === callerUid
  if (expenseIsSettlementLocked(expenseFields) && !isOwner) {
    throw new CascadeError(403, 'expense is settlement-locked; only the trip owner may re-run OCR')
  }

  // ── Receipt: path + type from the DOC, never from the client ─────
  const receipt = readMap(expenseFields, 'receipt')
  if (!receipt) throw new CascadeError(404, 'expense has no receipt')
  const receiptPath = readString(receipt, 'path')
  const receiptType = readString(receipt, 'type')
  if (!receiptPath) throw new CascadeError(404, 'expense receipt has no path')
  if (!receiptType || !receiptType.startsWith('image/')) {
    // PDFs / unsupported land here. OCR supports images only.
    throw new CascadeError(415, 'receipt is not an image; OCR supports images only')
  }
  // BOLA defence in depth: even though the path came from the doc, assert it
  // lives under this trip+expense before reading Storage with the admin
  // token (guards a corrupt / hand-written doc from pointing elsewhere).
  if (!receiptPath.startsWith(`trips/${tripId}/expenses/${expenseId}/`)) {
    throw new CascadeError(400, 'receipt path does not belong to this expense')
  }

  return { receiptPath, updatedAt: readTimestamp(expenseFields, 'updatedAt') }
}

export async function expenseReceiptOcr(
  callerUid:          string,
  req:                ExpenseReceiptOcrRequest,
  serviceAccountJson: string,
  bucket:             string,
  geminiApiKey:       string,
): Promise<ExpenseReceiptOcrResult> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  // ── Pre-OCR: authorize the caller + locate the receipt ───────────
  const before = await authorizeAndLocateReceipt(accessToken, projectId, req.tripId, req.expenseId, callerUid)
  const receiptPath = before.receiptPath

  // ── Storage: metadata first (size + GCS contentType), then bytes ──
  let meta
  try {
    meta = await getObjectMetadata(accessToken, bucket, receiptPath)
  } catch {
    throw new CascadeError(502, 'failed to read receipt metadata from storage')
  }
  if (!meta) throw new CascadeError(404, 'receipt object not found in storage')
  if (meta.size > MAX_RECEIPT_BYTES) {
    throw new CascadeError(413, 'receipt exceeds the 5MB OCR limit')
  }
  if (!meta.contentType.startsWith('image/')) {
    throw new CascadeError(415, 'stored receipt object is not an image')
  }

  let downloaded
  try {
    downloaded = await downloadObject(accessToken, bucket, receiptPath)
  } catch {
    throw new CascadeError(502, 'failed to download receipt from storage')
  }
  if (!downloaded) throw new CascadeError(404, 'receipt object not found in storage')
  if (downloaded.bytes.byteLength > MAX_RECEIPT_BYTES) {
    throw new CascadeError(413, 'receipt exceeds the 5MB OCR limit')
  }
  if (!downloaded.contentType.startsWith('image/')) {
    throw new CascadeError(415, 'downloaded receipt object is not an image')
  }

  // ── OCR (shared core; GCS contentType is the authoritative MIME) ─
  const imageBase64 = arrayBufferToBase64(downloaded.bytes)
  const result = await extractReceiptItems(imageBase64, downloaded.contentType, req.currencyHint, geminiApiKey)

  // ── Post-OCR revalidation ────────────────────────────────────────
  // Gemini runs for several seconds; anything that changes the answer can
  // shift in that window. RE-RUN the full authorization (not just a
  // path/updatedAt diff): it catches a role downgrade, a deleted expense/trip,
  // AND — crucially — a mid-OCR settlement lock for a non-owner, which the
  // lock write performs WITHOUT bumping updatedAt and a value-diff would miss.
  // Authz/existence loss surfaces as 403/404/410; applicability drift (swapped
  // receipt / edited expense) as 409. Pairs with the client's request-time +
  // monotonic-seq guards, which cover the windows the Worker can't see.
  const after = await authorizeAndLocateReceipt(accessToken, projectId, req.tripId, req.expenseId, callerUid)
  if (after.receiptPath !== before.receiptPath || after.updatedAt !== before.updatedAt) {
    throw new CascadeError(409, 'expense changed during OCR; refresh and retry')
  }

  return {
    result,
    sourceReceiptPath: before.receiptPath,
    expenseUpdatedAt:  before.updatedAt,
  }
}
