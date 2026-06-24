import type { BookingFormDraft, BookingFormState } from '../hooks/useBookingFormState'
import {
  PdfPageLimitError,
  pdfPageLimitMessageJa,
} from '@tripmate/pdf-page-limit'
import { isHttpUrl } from '@/types'
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

export interface BookingPdfExtractedField {
  value:      string
  confidence: number
  evidence:   string
}

export interface BookingPdfExtractResult {
  bookingType:      'hotel' | 'other'
  title:            BookingPdfExtractedField
  provider:         BookingPdfExtractedField
  confirmationCode: BookingPdfExtractedField
  checkIn:          BookingPdfExtractedField
  checkOut:         BookingPdfExtractedField
  address:          BookingPdfExtractedField
  link:             BookingPdfExtractedField
  warnings:         string[]
}

const FIELD_THRESHOLDS = {
  title:            0.6,
  provider:         0.55,
  confirmationCode: 0.6,
  checkIn:          0.65,
  checkOut:         0.65,
  address:          0.75,
  link:             0.8,
} as const

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

function bookingPdfFetchSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000)
  if (!external) return timeout
  return AbortSignal.any([timeout, external])
}

function shouldApply(field: BookingPdfExtractedField, threshold: number): boolean {
  return field.value.trim().length > 0 && field.confidence >= threshold
}

export function bookingPdfExtractToDraftPatch(
  state: BookingFormState,
  result: BookingPdfExtractResult,
  opts: { isEdit: boolean },
): { patch: BookingFormDraft; appliedCount: number } {
  const patch: BookingFormDraft = {}
  const isBlankIdentity = !state.title.trim() && !state.origin.trim() && !state.destination.trim()

  if (!opts.isEdit && isBlankIdentity && state.type === 'flight') {
    patch.type = result.bookingType
  }

  if (!state.title.trim() && shouldApply(result.title, FIELD_THRESHOLDS.title)) {
    patch.title = result.title.value.trim()
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
  if (!state.checkOut && shouldApply(result.checkOut, FIELD_THRESHOLDS.checkOut) && DATE_ONLY_RE.test(result.checkOut.value)) {
    patch.checkOut = result.checkOut.value
  }
  if (!state.address.trim() && shouldApply(result.address, FIELD_THRESHOLDS.address)) {
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
      throw new BookingPdfExtractError(pdfPageLimitMessageJa(e.code), 'parse')
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
    throw new BookingPdfExtractError('PDFを読み取れませんでした。手入力してください', 'parse')
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new BookingPdfExtractError('Booking PDF extract service is temporarily unavailable', 'unavailable')
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new BookingPdfExtractError(pdfExtractErrorMessage(res.status, detail), 'unknown')
  }

  return await res.json() as BookingPdfExtractResult
}
