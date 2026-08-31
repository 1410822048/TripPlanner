import { z } from 'zod'
import { initBookingFormState, type BookingFormDraft, type BookingFormState } from '../bookingFormState'
import { captureError } from '@/services/sentry'
import type { CreateBookingInput } from '@/types/booking'
import {
  PdfPageLimitError,
  pdfPageLimitMessage,
} from '@tripmate/pdf-page-limit'
import { isHttpUrl } from '@/types/_shared'
import { getFirebaseAuth } from '@/services/firebase'
import { WORKER_BASE_URL } from '@/services/workerBase'
import { extractBookingPdfText } from './bookingPdfText'

export type BookingPdfExtractErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'parse'
  | 'network'
  | 'unavailable'
  | 'unknown'

export class BookingPdfExtractError extends Error {
  readonly kind: BookingPdfExtractErrorKind
  constructor(message: string, kind: BookingPdfExtractErrorKind) {
    super(message)
    this.name = 'BookingPdfExtractError'
    this.kind = kind
  }
}

// The Worker owns the authoritative schema, including prompt descriptions
// and per-field length caps. This is the narrower structural contract the
// client needs to consume a response safely, and the types below are
// derived from it so the two can't drift.
//
// Deliberately NOT `.strict()`, unlike routeOptimizationService: unknown
// keys are stripped rather than rejected, so adding a field on the Worker
// stays a non-breaking change for clients already in the field.
const BookingTypeSchema = z.enum(['flight', 'hotel', 'train', 'bus', 'other'])
const SegmentRoleSchema = z.enum(['single', 'outbound', 'return', 'connection', 'unknown'])

const ExtractedFieldSchema = z.object({
  value:      z.string(),
  confidence: z.number(),
  evidence:   z.string(),
})

const BookingPdfExtractCandidateSchema = z.object({
  bookingType:         BookingTypeSchema,
  segmentRole:         SegmentRoleSchema,
  title:               ExtractedFieldSchema,
  provider:            ExtractedFieldSchema,
  confirmationCode:    ExtractedFieldSchema,
  origin:              ExtractedFieldSchema,
  destination:         ExtractedFieldSchema,
  originIataCode:      ExtractedFieldSchema,
  destinationIataCode: ExtractedFieldSchema,
  checkIn:             ExtractedFieldSchema,
  checkOut:            ExtractedFieldSchema,
  address:             ExtractedFieldSchema,
  link:                ExtractedFieldSchema,
})

const BookingPdfExtractResultSchema = z.object({
  // Mirrors the Worker's `.min(1)`: a candidate-less response is a broken
  // contract, not an empty result for the UI to render.
  bookings: z.array(BookingPdfExtractCandidateSchema).min(1),
  warnings: z.array(z.string()),
})

export type BookingPdfExtractedField = z.infer<typeof ExtractedFieldSchema>
export type BookingPdfExtractBookingType = z.infer<typeof BookingTypeSchema>
export type BookingPdfExtractCandidate = z.infer<typeof BookingPdfExtractCandidateSchema>
export type BookingPdfExtractResult = z.infer<typeof BookingPdfExtractResultSchema>

const FIELD_THRESHOLDS = {
  title:            0.6,
  provider:         0.55,
  confirmationCode: 0.6,
  origin:           0.7,
  destination:      0.7,
  iataCode:         0.7,
  checkIn:          0.65,
  checkOut:         0.65,
  address:          0.75,
  link:             0.8,
} as const

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const IATA_CODE_RE = /^[A-Z]{3}$/
const TRANSPORT_TYPES = new Set<BookingPdfExtractBookingType>(['flight', 'train', 'bus'])

function bookingPdfFetchSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000)
  if (!external) return timeout
  return AbortSignal.any([timeout, external])
}

function shouldApply(field: BookingPdfExtractedField, threshold: number): boolean {
  return field.value.trim().length > 0 && field.confidence >= threshold
}

function iataCodeValue(field: BookingPdfExtractedField): string {
  const code = field.value.trim().toUpperCase()
  return IATA_CODE_RE.test(code) && field.confidence >= FIELD_THRESHOLDS.iataCode ? code : ''
}

/**
 * Route endpoint for a transport candidate. Split by type on purpose: a
 * flight is gated by FIELD_THRESHOLDS.iataCode via iataCodeValue and never
 * consults the location threshold, so passing one here would read as if it
 * applied.
 *
 * 航班航線只儲存 IATA 三碼。機場全名保留在 OCR evidence，避免窄版卡片
 * 截斷後只看到冗長名稱、反而看不到真正可辨識的代號。
 */
function transportLocationValue(
  type:      BookingPdfExtractBookingType,
  location:  BookingPdfExtractedField,
  iataCode:  BookingPdfExtractedField,
  threshold: number,
): string {
  return type === 'flight'
    ? iataCodeValue(iataCode)
    : stationNameValue(location, threshold)
}

function stationNameValue(location: BookingPdfExtractedField, threshold: number): string {
  return shouldApply(location, threshold) ? location.value.trim() : ''
}

export function bookingPdfExtractToDraftPatch(
  state: BookingFormState,
  result: BookingPdfExtractCandidate,
  opts: { isEdit: boolean },
): { patch: BookingFormDraft; appliedCount: number } {
  const patch: BookingFormDraft = {}
  const isBlankIdentity = !state.title.trim() && !state.origin.trim() && !state.destination.trim()

  if (!opts.isEdit && isBlankIdentity && state.type === 'flight' && result.bookingType !== 'flight') {
    patch.type = result.bookingType
  }
  const targetType = patch.type ?? state.type
  const targetIsTransport = TRANSPORT_TYPES.has(targetType)

  if (!state.title.trim() && shouldApply(result.title, FIELD_THRESHOLDS.title)) {
    patch.title = result.title.value.trim()
  }
  if (targetIsTransport && !state.origin.trim()) {
    const origin = transportLocationValue(
      targetType,
      result.origin,
      result.originIataCode,
      FIELD_THRESHOLDS.origin,
    )
    if (origin) patch.origin = origin
  }
  if (targetIsTransport && !state.destination.trim()) {
    const destination = transportLocationValue(
      targetType,
      result.destination,
      result.destinationIataCode,
      FIELD_THRESHOLDS.destination,
    )
    if (destination) patch.destination = destination
  }
  if (!state.provider.trim() && shouldApply(result.provider, FIELD_THRESHOLDS.provider)) {
    patch.provider = result.provider.value.trim()
  }
  if (!state.confirmationCode.trim() && shouldApply(result.confirmationCode, FIELD_THRESHOLDS.confirmationCode)) {
    patch.confirmationCode = result.confirmationCode.value.trim()
  }
  if (!state.checkIn && shouldApply(result.checkIn, FIELD_THRESHOLDS.checkIn) && DATE_ONLY_RE.test(result.checkIn.value)) {
    patch.checkIn = result.checkIn.value
  }
  if (targetType === 'hotel' && !state.checkOut && shouldApply(result.checkOut, FIELD_THRESHOLDS.checkOut) && DATE_ONLY_RE.test(result.checkOut.value)) {
    patch.checkOut = result.checkOut.value
  }
  if (!targetIsTransport && !state.address.trim() && shouldApply(result.address, FIELD_THRESHOLDS.address)) {
    patch.address = result.address.value.trim()
  }
  if (!state.link.trim() && shouldApply(result.link, FIELD_THRESHOLDS.link)) {
    const link = result.link.value.trim()
    if (isHttpUrl(link)) patch.link = link
  }

  return {
    patch,
    appliedCount: Object.keys(patch).length,
  }
}

export function bookingPdfCandidateToCreateInput(
  candidate: BookingPdfExtractCandidate,
): CreateBookingInput | null {
  const blankState = initBookingFormState(null)
  const { patch } = bookingPdfExtractToDraftPatch(blankState, candidate, { isEdit: false })
  const type = patch.type ?? blankState.type
  const isTransport = TRANSPORT_TYPES.has(type)

  if (isTransport && (!patch.origin || !patch.destination)) return null
  if (!isTransport && !patch.title) return null

  return {
    type,
    ...patch,
    origin:      isTransport ? patch.origin : undefined,
    destination: isTransport ? patch.destination : undefined,
    checkOut:    type === 'hotel' ? patch.checkOut : undefined,
    address:     isTransport ? undefined : patch.address,
  }
}

function pdfExtractErrorMessage(status: number, detail: string): string {
  try {
    const body = JSON.parse(detail) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // Fall through to status fallback.
  }
  return `PDF extract failed (${status})`
}

export async function extractBookingPdfAutofill(
  file:   File,
  signal?: AbortSignal,
): Promise<BookingPdfExtractResult> {
  const { auth } = await getFirebaseAuth()
  const user = auth.currentUser
  if (!user) throw new BookingPdfExtractError('Not signed in', 'auth')

  let digest: Awaited<ReturnType<typeof extractBookingPdfText>>
  try {
    digest = await extractBookingPdfText(file, signal)
  } catch (e) {
    if (e instanceof PdfPageLimitError) {
      throw new BookingPdfExtractError(pdfPageLimitMessage(e.code), 'parse')
    }
    throw e
  }
  const token = await user.getIdToken()

  let res: Response
  try {
    res = await fetch(`${WORKER_BASE_URL}/booking-pdf-extract`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(digest),
      signal: bookingPdfFetchSignal(signal),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new BookingPdfExtractError('PDF extract timed out', 'network')
    }
    throw new BookingPdfExtractError(`Network error: ${err.message}`, 'network')
  }

  if (res.status === 401) throw new BookingPdfExtractError('Session expired', 'auth')
  if (res.status === 429) throw new BookingPdfExtractError('Rate limit reached', 'rate-limit')
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    throw new BookingPdfExtractError('無法讀取 PDF，請手動輸入', 'parse')
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new BookingPdfExtractError('Booking PDF extract service is temporarily unavailable', 'unavailable')
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new BookingPdfExtractError(pdfExtractErrorMessage(res.status, detail), 'unknown')
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new BookingPdfExtractError('無法讀取 PDF，請手動輸入', 'parse')
  }

  const parsed = BookingPdfExtractResultSchema.safeParse(payload)
  if (!parsed.success) {
    // A 200 with the wrong shape means Pages and the Worker have drifted.
    // Nothing the user can do, but we need to hear about it.
    captureError(parsed.error, { source: 'bookingPdfExtract/response' })
    throw new BookingPdfExtractError('讀取服務回傳的資料格式不相容，請手動輸入', 'parse')
  }
  return parsed.data
}
