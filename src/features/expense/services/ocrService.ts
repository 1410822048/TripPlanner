// src/features/expense/services/ocrService.ts
// Client-side wrapper for the Cloudflare OCR worker. Takes a receipt File,
// returns parsed items[] + total.
//
// Why a thin service module:
//   - The fetch + base64 encoding + token retrieval are non-trivial enough
//     to deserve their own seam, but not enough to need a hook
//   - The form component shouldn't know about Worker URLs, JWT extraction,
//     or HTTP error shapes — those are infra concerns
//
// Auth: pulls the current Firebase ID token via getFirebaseAuth(). The
// token is short-lived (~1 hour) so we fetch fresh each call rather than
// caching — the SDK already caches internally and gives us a refreshed
// token automatically if needed.
import { getFirebaseAuth } from '@/services/firebase'

export interface OcrItem {
  name: string
  /** Positive decimal string in the receipt currency (e.g. "12.34" /
   *  "500"). Caller parses to integer minor units via
   *  `parseMoneyToMinor(amountText, currency)` at the form→Firestore
   *  boundary so the wire never carries an IEEE-754 float. Discounts /
   *  surcharges arrive via `OcrResult.adjustments[]` instead. */
  amountText: string
}

/** Adjustment kind hint from OCR. Mirrors the Worker schema
 *  (`OcrAdjustmentKindSchema`) and the persisted `ExpenseAdjustmentKind`
 *  on the client. Worker is the source of truth — kept in lockstep with
 *  workers/ocr/src/schema.ts. */
export type OcrAdjustmentKind =
  | 'DISCOUNT'
  | 'COUPON'
  | 'TAX_EXEMPT'
  | 'SURCHARGE'
  | 'TAX'
  | 'TIP'
  | 'OTHER'

/** OCR-only scope hint. `UNKNOWN` is downgraded by the client form
 *  (Phase B default: → EXPENSE) before any persistence call. Persisted
 *  adjustments only carry ITEM / EXPENSE. */
export type OcrAdjustmentScope = 'ITEM' | 'EXPENSE' | 'UNKNOWN'

export interface OcrAdjustment {
  label: string
  kind:  OcrAdjustmentKind
  /** Positive decimal string in the receipt currency. Sign is encoded by
   *  `kind`. Caller parses via `parseMoneyToMinor(amountText, currency)`. */
  amountText: string
  suggestedScope: OcrAdjustmentScope
  /** Index into `items[]` when scope === 'ITEM'. The client resolves
   *  this to a freshly-minted `targetItemId` before constructing the
   *  persisted ExpenseAdjustment. */
  suggestedTargetItemIndex?: number
}

/** OCR-visible receipt text intentionally excluded from financial math.
 *  Examples: included-tax disclosure, payment method, cash received,
 *  change, receipt/register id, address/phone/footer noise. */
export type OcrIgnoredLine = string

/** 必須與 src/types/expense.ts 的 ExpenseCategory 同步;worker schema
 *  那邊也有一份對應 enum(OcrCategorySchema)。 */
export type OcrCategory =
  | 'food'
  | 'transport'
  | 'accommodation'
  | 'activity'
  | 'shopping'
  | 'other'

export interface OcrResult {
  items:     OcrItem[]
  /** Phase B contract: always present (empty array when none). */
  adjustments: OcrAdjustment[]
  /** Phase B contract: always present. Client currently ignores this
   *  bucket; it exists so OCR can avoid forcing non-financial receipt
   *  lines into items[] / adjustments[]. */
  ignoredLines: OcrIgnoredLine[]
  /** Receipt grand total as a positive decimal string. Caller parses via
   *  `parseMoneyToMinor(totalText, currency)`. Empty receipts emit "0". */
  totalText: string
  currency?: string
  /** Store / venue name from the receipt header. Optional — present
   *  when the OCR model can confidently identify a single store name. */
  storeName?: string
  /** Inferred expense category. Optional — the OCR model may omit when the
   *  receipt is ambiguous. Caller applies only on new expenses to
   *  avoid clobbering an edit. */
  category?: OcrCategory
}

import { WORKER_BASE_URL, requireWorkerWriteBase } from '@/services/workerBase'

const OCR_SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type OcrErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'parse'
  | 'network'
  | 'unavailable'
  | 'stale'
  | 'forbidden'
  | 'unknown'

// Field declared explicitly (not via constructor-param syntax) because the
// project's tsconfig sets `erasableSyntaxOnly`, which forbids parameter
// properties (a TS-only sugar that doesn't survive type erasure).
export class OcrError extends Error {
  readonly kind: OcrErrorKind
  constructor(message: string, kind: OcrErrorKind) {
    super(message)
    this.kind = kind
  }
}

/** Base64-encode a File using FileReader → string after the "base64,"
 *  prefix. Streams chunks under the hood so even multi-MB images don't
 *  block the main thread. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'))
        return
      }
      // strip "data:image/jpeg;base64," prefix — worker wants pure base64
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

/** Combine the hard 60s OCR timeout with an OPTIONAL caller abort signal.
 *  Either source aborts the fetch: the caller cancels stale OCR when the user
 *  swaps / clears the receipt, while the timeout still bounds a hung worker.
 *
 *  `AbortSignal.any` is Baseline 2024 (Chrome 116 / Firefox 124 / Safari 17.4).
 *  The app's client baseline is Safari/iOS 17.4+, so it's used directly rather
 *  than hand-combining controllers. (`AbortSignal.timeout`, already used here,
 *  is the older Safari 16.4+ floor.) */
function ocrFetchSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(60_000)
  if (!external) return timeout
  return AbortSignal.any([timeout, external])
}

export function isOcrSupportedImageMimeType(type: string | undefined): boolean {
  const normalized = type?.split(';', 1)[0]?.trim().toLowerCase()
  return !!normalized && OCR_SUPPORTED_IMAGE_MIME_TYPES.has(normalized)
}

export function isOcrSupportedImageFile(file: File | null | undefined): boolean {
  return !!file && isOcrSupportedImageMimeType(file.type)
}

async function postOcrImage<T>(
  endpoint: string,
  file:     File,
  currency: string | undefined,
  signal:   AbortSignal | undefined,
  copy:     { timeout: string; failed: string },
): Promise<T> {
  if (!isOcrSupportedImageFile(file)) {
    throw new OcrError('OCR supports JPEG, PNG, or WebP receipt images', 'parse')
  }

  const { auth } = await getFirebaseAuth()
  const user = auth.currentUser
  if (!user) {
    throw new OcrError('Not signed in', 'auth')
  }
  const token = await user.getIdToken()
  const image = await fileToBase64(file)

  let res: Response
  try {
    res = await fetch(`${WORKER_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        image,
        mimeType: file.type || 'image/jpeg',
        currency,
      }),
      signal: ocrFetchSignal(signal),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new OcrError(copy.timeout, 'network')
    }
    throw new OcrError(`Network error: ${err.message}`, 'network')
  }

  if (res.status === 401) throw new OcrError('Session expired', 'auth')
  if (res.status === 429) throw new OcrError('Rate limit reached', 'rate-limit')
  if (res.status === 422) throw new OcrError('Could not read receipt', 'parse')
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new OcrError('OCR service is temporarily unavailable', 'unavailable')
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new OcrError(`${copy.failed} (${res.status}): ${detail.slice(0, 120)}`, 'unknown')
  }

  return await res.json() as T
}

/**
 * Extract receipt line items from an image. Throws OcrError with a `kind`
 * the UI can render distinct copy for ("登入逾時 / 速率限制 / 無法辨識...").
 *
 * `currency` is a hint, not a constraint — when omitted, the OCR model guesses
 * from receipt symbols. Pass the trip currency for better accuracy on
 * ambiguous receipts (e.g. a "$" that could be USD/TWD/CAD).
 */
export async function ocrReceipt(file: File, currency?: string, signal?: AbortSignal): Promise<OcrResult> {
  return postOcrImage<OcrResult>('/ocr', file, currency, signal, {
    timeout: 'OCR request timed out',
    failed:  'OCR failed',
  })
}

/** Explicit backup path. This is user-triggered; the product path does not
 *  silently double-run models and hide the latency/cost from the user. */
export async function ocrFallbackReceipt(file: File, currency?: string, signal?: AbortSignal): Promise<OcrResult> {
  return postOcrImage<OcrResult>('/ocr-fallback', file, currency, signal, {
    timeout: 'OCR fallback timed out',
    failed:  'OCR fallback failed',
  })
}

/** Response envelope for the re-OCR-existing-receipt endpoint. Carries the
 *  OCR candidate PLUS race metadata the caller checks before applying:
 *  `sourceReceiptPath` (the object the Worker actually read) and
 *  `expenseUpdatedAt` (the doc's updatedAt at OCR time). */
export interface ExpenseReceiptOcrResponse {
  result:            OcrResult
  sourceReceiptPath: string
  expenseUpdatedAt?: string
}

/**
 * Re-run OCR against an EXISTING expense's stored receipt. This is a user
 * refresh action, so the Worker runs the model again instead of replaying a
 * previous OCR result. The client never
 * names the object — the Worker reads receipt.path from the Firestore doc
 * (BOLA-safe) and enforces /expense-update permissions (owner/editor;
 * settlement-locked ⇒ owner). Used by the edit-modal "再読み取り" button
 * when there's no freshly-picked File (the old receipt is only a URL).
 *
 * Returns the OCR result + race metadata; the CALLER must verify the result
 * still applies to the open modal (receipt path unchanged, expense not
 * edited mid-flight) before applying it.
 */
async function ocrExistingExpenseReceiptEndpoint(
  endpoint:     '/expense-receipt-ocr' | '/expense-receipt-ocr-fallback',
  tripId:       string,
  expenseId:    string,
  currencyHint?: string,
  signal?:      AbortSignal,
): Promise<ExpenseReceiptOcrResponse> {
  const { auth } = await getFirebaseAuth()
  const user = auth.currentUser
  if (!user) throw new OcrError('Not signed in', 'auth')
  const token = await user.getIdToken()

  // Privileged data-plane: this route reads the expense doc + downloads the
  // stored receipt with the Worker's admin service-account. Unlike the
  // caller-supplied-bytes /ocr route, it MUST NOT fall back to the prod
  // Worker from an unconfigured preview/local build (that would read prod
  // Firestore/Storage). requireWorkerWriteBase() is the same no-prod-fallback
  // gate the mutating endpoints use — it enforces an explicit
  // VITE_WORKER_BASE_URL and throws otherwise.
  const base = requireWorkerWriteBase()

  let res: Response
  try {
    res = await fetch(`${base}${endpoint}`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      // ONLY identifiers cross the wire — never the receipt path.
      body:    JSON.stringify({ tripId, expenseId, ...(currencyHint ? { currencyHint } : {}) }),
      signal:  ocrFetchSignal(signal),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new OcrError('OCR request timed out', 'network')
    }
    throw new OcrError(`Network error: ${err.message}`, 'network')
  }

  if (res.status === 401) throw new OcrError('Session expired',        'auth')
  if (res.status === 429) throw new OcrError('Rate limit reached',     'rate-limit')
  // 403 = permission lost since the modal opened: the caller is no longer
  // owner/editor, OR the expense became settlement-locked (someone recorded
  // 済み mid-OCR) and the caller isn't the trip owner. Either way a re-OCR
  // edit can't be applied — give it a distinct kind so the UI shows an
  // actionable message, not a raw "OCR failed (403)".
  if (res.status === 403) throw new OcrError('Forbidden: cannot edit this expense', 'forbidden')
  // 409 = the Worker's post-OCR revalidation found the receipt/expense
  // changed while OCR was running → the result is for a stale image.
  if (res.status === 409) throw new OcrError('Expense changed during OCR', 'stale')
  // 422 = model couldn't read; 415 = stored object isn't a provider-readable image
  // (shouldn't reach here — the button gates on image receipts — but map
  // it to the same "couldn't read" copy rather than a raw status).
  if (res.status === 422 || res.status === 415) throw new OcrError('Could not read receipt', 'parse')
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new OcrError('OCR service is temporarily unavailable', 'unavailable')
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new OcrError(`OCR failed (${res.status}): ${detail.slice(0, 120)}`, 'unknown')
  }

  return await res.json() as ExpenseReceiptOcrResponse
}

export function ocrExistingExpenseReceipt(
  tripId:       string,
  expenseId:    string,
  currencyHint?: string,
  signal?:      AbortSignal,
): Promise<ExpenseReceiptOcrResponse> {
  return ocrExistingExpenseReceiptEndpoint('/expense-receipt-ocr', tripId, expenseId, currencyHint, signal)
}

export function ocrExistingExpenseReceiptFallback(
  tripId:       string,
  expenseId:    string,
  currencyHint?: string,
  signal?:      AbortSignal,
): Promise<ExpenseReceiptOcrResponse> {
  return ocrExistingExpenseReceiptEndpoint('/expense-receipt-ocr-fallback', tripId, expenseId, currencyHint, signal)
}

/**
 * Race guard for re-OCR of an existing receipt: is the returned result still
 * applicable to the modal that fired the request? True only when the Worker
 * OCR'd the SAME receipt path the caller captured at request time AND — when
 * BOTH sides carry it — the expense's `updatedAt` is unchanged. A missing
 * `updatedAt` on either side falls back to the receipt-path check alone.
 *
 * Why: between firing the request and the response landing, another client
 * could replace the receipt (path changes) or edit the expense (updatedAt
 * advances). Applying a stale OCR result would overwrite the draft with
 * items for a different image, so the caller discards it instead.
 *
 * `updatedAtMillis` is the captured `Timestamp.toMillis()`; `expenseUpdatedAt`
 * is the Worker's RFC3339 string — compared at millisecond precision (both
 * derive from the same Firestore write, so their millis match exactly).
 */
export function ocrResultStillApplicable(
  captured: { receiptPath: string; updatedAtMillis?: number },
  response: { sourceReceiptPath: string; expenseUpdatedAt?: string },
): boolean {
  if (response.sourceReceiptPath !== captured.receiptPath) return false
  if (response.expenseUpdatedAt && captured.updatedAtMillis != null) {
    return new Date(response.expenseUpdatedAt).getTime() === captured.updatedAtMillis
  }
  return true
}
