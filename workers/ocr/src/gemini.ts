// Gemini API client — single-purpose: send a receipt image, get structured
// items[] + total back.
//
// Why raw fetch (not @google/genai SDK):
//   - The SDK pulls in ~150KB of runtime dep tree we don't need
//   - We only ever call one method (generateContent)
//   - Workers cold-start cost is proportional to bundle size
//   - The REST call is 30 lines and stable
//
// Model choice: gemini-3-flash-preview — the user picked this. It's the
// strongest Flash vision model in the Gemini 3 family. Note "preview" =
// Google reserves the right to change behaviour or shut down; we wrap the
// model name in a constant so future swap is one line.
import { OcrResponseSchema, GEMINI_RESPONSE_SCHEMA, type OcrResponse } from './schema'

const MODEL = 'gemini-3-flash-preview'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

// Prompt is intentionally terse — Gemini's structured-output mode does the
// heavy lifting of forcing the right shape, so the prompt only needs to
// communicate intent + language preservation.
function buildPrompt(currencyHint?: string): string {
  return [
    'You are extracting line items from a receipt photo.',
    '',
    'Rules:',
    '- Preserve the original language of each item name exactly (do not translate).',
    '- amount is the line total in MAJOR units (e.g. yen = whole yen, USD = dollars with cents as decimals). Tax/service rows are valid items too.',
    '- Discount / cashback / promo / refund lines are valid items with NEGATIVE amounts (e.g. "キャッシュレス還元 -6", "割引 -50"). When the receipt prints a positive number in a discount column or with a label like 還元/割引/値引, output the amount as negative so sum(items) === total.',
    '- "total" is the receipt grand total the customer paid (after tax / service / discounts).',
    '- "storeName" is the store, restaurant, or venue name printed at the top of the receipt. Use the most prominent / largest name (skip branch numbers, addresses, phone numbers). Omit if no clear store identifier exists.',
    '- "category" is the most likely expense category for this receipt. Choose ONE from this fixed list, based on the storeName + line items:',
    '    - food          : restaurants, cafés, bars, supermarkets, convenience stores, takeout, drinks (居酒屋 / カフェ / レストラン / コンビニ / スーパー / 食堂)',
    '    - transport     : trains, taxis, buses, flights, fuel, parking, tolls, IC card top-ups (タクシー / JR / 地下鉄 / バス / ガソリン / 駐車場 / Suica)',
    '    - accommodation : hotels, ryokan, hostels, Airbnb, lodging fees (ホテル / 旅館 / 民宿)',
    '    - activity      : tickets, museums, theme parks, tours, experiences, attractions (チケット / 入場料 / ツアー / 美術館)',
    '    - shopping      : clothing, electronics, souvenirs, drugstores, department stores, non-food retail (服 / 雑貨 / お土産 / ドラッグストア / 百貨店)',
    '    - other         : anything that does not clearly fit above (medical, ATM fees, services, mixed receipts where intent is unclear)',
    '  Omit "category" only when truly indeterminable. Prefer guessing over omitting.',
    '- Skip header/footer noise (address, phone, register ID, payment method, EFTPOS confirmation lines, "thank you for shopping" text).',
    '- If the receipt is unreadable, return items: [] and total: 0.',
    currencyHint
      ? `- Currency hint: ${currencyHint} (use this when the receipt symbol is ambiguous).`
      : '',
  ].filter(Boolean).join('\n')
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> }
  finishReason?: string
}

interface GeminiResponseEnvelope {
  candidates?: GeminiCandidate[]
  promptFeedback?: { blockReason?: string }
}

export class GeminiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

/**
 * Send a base64 image to Gemini and return parsed items[] + total.
 * Throws GeminiError with an HTTP-flavoured status hint:
 *   - 400 → bad image / Gemini rejected the prompt
 *   - 422 → Gemini returned but output couldn't be parsed OR was empty
 *   - 502 → network / upstream error
 *
 * Logs go to console (visible via `wrangler tail`) at every meaningful
 * branch so debugging "why did OCR fail?" doesn't require redeploying
 * with extra prints.
 */
export async function extractReceiptItems(
  imageBase64: string,
  mimeType:    string,
  currency:    string | undefined,
  apiKey:      string,
): Promise<OcrResponse> {
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: buildPrompt(currency) },
      ],
    }],
    generationConfig: {
      responseMimeType:   'application/json',
      responseJsonSchema: GEMINI_RESPONSE_SCHEMA,
    },
  }

  const t0 = Date.now()
  console.log(`[gemini] request: model=${MODEL} mime=${mimeType} imgBytes≈${Math.round(imageBase64.length * 0.75)} currency=${currency ?? 'auto'}`)

  // Explicit subrequest timeout. Workers don't enforce a per-subrequest
  // budget — without this, a hung Gemini call rides the whole 30s wall-
  // time until the platform kills the worker, producing a generic
  // failure. 45s is well under Cloudflare's wall-time budget and matches
  // the client's 60s patience window.
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-goog-api-key': apiKey,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (e) {
    const err = e as Error
    // AbortSignal.timeout fires with name='TimeoutError' (DOMException);
    // distinguish so the client / logs can act on it (retry-worthy vs
    // upstream-network-flake).
    if (err.name === 'TimeoutError') {
      console.error(`[gemini] timeout after 45s`)
      throw new GeminiError('Upstream timeout after 45s', 504)
    }
    console.error(`[gemini] network error: ${err.message}`)
    throw new GeminiError(`Upstream network error: ${err.message}`, 502)
  }

  const elapsed = Date.now() - t0
  console.log(`[gemini] response: status=${res.status} elapsed=${elapsed}ms`)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // Log the truncated detail body — invaluable for diagnosing
    // "your quota is exceeded" / "model not found" / "safety block".
    console.error(`[gemini] error body (truncated): ${detail.slice(0, 500)}`)
    // 401/403 from Gemini almost always mean OUR GEMINI_API_KEY is bad
    // (expired, revoked, or scoped wrong) or the project lost quota
    // grant. Emit a distinct log line so this jumps out of wrangler tail
    // — past incidents went unnoticed for hours because the generic
    // 502 mask buried the root cause. Client still receives 502 (we
    // don't leak our auth state through HTTP status to callers).
    if (res.status === 401 || res.status === 403) {
      console.error(
        `[gemini] OPERATOR ATTENTION: Gemini returned ${res.status} — ` +
        `check GEMINI_API_KEY secret + Google AI quota / project enablement`,
      )
    }
    throw new GeminiError(
      `Gemini ${res.status}: ${detail.slice(0, 200)}`,
      res.status === 429 ? 429 : 502,
    )
  }

  const envelope = await res.json() as GeminiResponseEnvelope

  if (envelope.promptFeedback?.blockReason) {
    console.warn(`[gemini] content blocked: ${envelope.promptFeedback.blockReason}`)
    throw new GeminiError(`Content blocked: ${envelope.promptFeedback.blockReason}`, 400)
  }

  const candidate = envelope.candidates?.[0]
  const text = candidate?.content?.parts?.[0]?.text
  console.log(`[gemini] finishReason=${candidate?.finishReason ?? '?'} textLen=${text?.length ?? 0}`)

  if (typeof text !== 'string') {
    console.error('[gemini] no text part in response', JSON.stringify(envelope).slice(0, 500))
    throw new GeminiError('Gemini returned no text part', 422)
  }

  // Log the raw text Gemini sent back — short enough to be useful, and
  // critical for "is Gemini saying items: [] or just garbage?" diagnosis.
  console.log(`[gemini] raw text (truncated): ${text.slice(0, 500)}`)

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new GeminiError('Gemini returned non-JSON text', 422)
  }

  const parsed = OcrResponseSchema.safeParse(json)
  if (!parsed.success) {
    console.error(`[gemini] schema mismatch: ${parsed.error.message.slice(0, 300)}`)
    throw new GeminiError(`Schema mismatch: ${parsed.error.message.slice(0, 200)}`, 422)
  }

  // Empty-items branch — Gemini parsed the prompt correctly and decided
  // it can't read the image. Map to a distinct error so the client
  // shows "看不懂,重拍" instead of a generic schema fail.
  if (parsed.data.items.length === 0) {
    console.warn(`[gemini] unreadable: items=[] total=${parsed.data.total}`)
    throw new GeminiError('Receipt unreadable (Gemini returned empty items)', 422)
  }

  console.log(`[gemini] success: items=${parsed.data.items.length} total=${parsed.data.total} currency=${parsed.data.currency ?? '?'}`)
  return parsed.data
}
