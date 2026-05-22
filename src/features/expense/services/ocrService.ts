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
  name:   string
  amount: number
}

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
  total:     number
  currency?: string
  /** Store / venue name from the receipt header. Optional — present
   *  when Gemini can confidently identify a single store name. */
  storeName?: string
  /** Inferred expense category. Optional — Gemini may omit when the
   *  receipt is ambiguous. Caller applies only on new expenses to
   *  avoid clobbering an edit. */
  category?: OcrCategory
}

import { WORKER_BASE_URL } from '@/services/workerBase'

export type OcrErrorKind = 'auth' | 'rate-limit' | 'parse' | 'network' | 'unknown'

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

/**
 * Extract receipt line items from an image. Throws OcrError with a `kind`
 * the UI can render distinct copy for ("登入逾時 / 速率限制 / 無法辨識...").
 *
 * `currency` is a hint, not a constraint — when omitted, Gemini guesses
 * from receipt symbols. Pass the trip currency for better accuracy on
 * ambiguous receipts (e.g. a "$" that could be USD/TWD/CAD).
 */
export async function ocrReceipt(file: File, currency?: string): Promise<OcrResult> {
  // Auth — fail early before doing the (potentially slow) base64 encode.
  const { auth } = await getFirebaseAuth()
  const user = auth.currentUser
  if (!user) {
    throw new OcrError('Not signed in', 'auth')
  }
  const token = await user.getIdToken()

  const image = await fileToBase64(file)

  let res: Response
  try {
    // 60s hard timeout via AbortSignal.timeout — native Web API, no
    // polyfill needed (Safari 16.4+, Chrome 103+). Without it a hung
    // worker / DNS blackhole leaves the UI's "解析中…" spinner up
    // indefinitely. Worker p99 latency is ~5s, so 60s is generous.
    res = await fetch(`${WORKER_BASE_URL}/ocr`, {
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
      signal: AbortSignal.timeout(60_000),
    })
  } catch (e) {
    // AbortError comes out as DOMException with name='TimeoutError' when
    // the AbortSignal.timeout fires. Map both flavours to our 'network'
    // kind so the UI shows the consistent "ネットワークエラー" message.
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new OcrError('OCR request timed out', 'network')
    }
    throw new OcrError(`Network error: ${err.message}`, 'network')
  }

  if (res.status === 401) throw new OcrError('Session expired',     'auth')
  if (res.status === 429) throw new OcrError('Rate limit reached',  'rate-limit')
  if (res.status === 422) throw new OcrError('Could not read receipt', 'parse')
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new OcrError(`OCR failed (${res.status}): ${detail.slice(0, 120)}`, 'unknown')
  }

  const data = await res.json() as OcrResult
  return data
}
