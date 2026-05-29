// Gemini API client — single-purpose: send a receipt image, get structured
// items[] + total back.
//
// Why raw fetch (not @google/genai SDK):
//   - The SDK pulls in ~150KB of runtime dep tree we don't need
//   - We only ever call one method (generateContent)
//   - Workers cold-start cost is proportional to bundle size
//   - The REST call is 30 lines and stable
//
// Model choice: gemini-3.5-flash -- the GA successor to
// gemini-3-flash-preview (Google I/O 2026, GA from day one with no
// preview suffix). Compatible API surface (responseJsonSchema,
// inline_data image input, generateContent endpoint) so the call
// shape doesn't change. OCR / document extraction quality is
// measurably stronger on Google's published benchmarks.
//
// Free-tier quota / paid pricing are EXTERNAL facts that Google can
// adjust at any time -- check the current Gemini API pricing &
// rate-limit pages before assuming the cost/quota of any swap.
//
// The model name is wrapped in a constant so future swaps stay a
// one-line change.
import { OcrResponseSchema, GEMINI_RESPONSE_SCHEMA, type OcrResponse } from './schema'

const MODEL = 'gemini-3.5-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

// Prompt is intentionally terse — Gemini's structured-output mode does the
// heavy lifting of forcing the right shape, so the prompt only needs to
// communicate intent + language preservation.
function buildPrompt(currencyHint?: string): string {
  return [
    'You are extracting line items + adjustments from a receipt photo.',
    '',
    'Rules:',
    '- Preserve the original language of each item / adjustment label exactly (do not translate).',
    '- items[] holds POSITIVE-only product / service line totals as the pre-discount subtotal printed next to each product line, in the receipt currency.',
    '- amountText / totalText wire format: ASCII digits with an optional single dot for the fractional part (e.g. "12.34" for USD, "500" for JPY, "300" for TWD). NO thousand separators (no comma, no space, no full-width comma), NO currency symbols, NO leading sign, NO scientific notation. JPY/KRW/TWD/VND/IDR are zero-fraction currencies — emit integer-only strings for them. Do NOT scale to minor units. Do NOT round; preserve the printed precision.',
    '- adjustments[] holds receipt-wide and per-item modifiers that CHANGE the paid total: discount / cashback / coupon / tax-exempt (negative effect) AND surcharge / service / tax / tip (positive effect). amountText on every adjustment is a POSITIVE decimal string in the same wire format as items[].amountText; the sign is encoded by `kind`.',
    '    - kind = DISCOUNT | COUPON | TAX_EXEMPT (subtract from receipt total)',
    '    - kind = SURCHARGE | TAX | TIP            (add to receipt total)',
    '    - kind = OTHER                           (use when truly ambiguous; defaults to subtract downstream)',
    '- suggestedScope hints whether the adjustment targets a single item or the whole receipt:',
    '    - ITEM    : printed immediately under / beside one product line ("Donut 200 / 値引 -20")',
    '    - EXPENSE : receipt-wide line (subtotal-level tax, service charge, total discount)',
    '    - UNKNOWN : can\'t tell from layout; pick this only when neither ITEM nor EXPENSE is clearly correct',
    '- suggestedTargetItemIndex is the 0-based index into items[] when scope is ITEM. Omit when scope is EXPENSE or UNKNOWN.',
    '- ignoredLines[] holds visible receipt lines that do NOT change the paid total: included-tax disclosures such as 内税/内消費税/消費税等, subtotal echoes, payment method, cash received, change, receipt number, register id, address, phone, and footer text. Preserve the original text.',
    '- TAX is only for a tax line that is added to a pre-tax subtotal and actually changes the grand total. If item prices already include tax and the receipt merely discloses the included tax amount, put that line in ignoredLines[], not adjustments[].',
    '- "totalText" is the receipt grand total the customer paid (after tax / service / discounts), formatted as a decimal string in the receipt currency (same format as items[].amountText). The identity sum(items[].amountText) + Σ(adjustment sign × adjustment.amountText) === totalText MUST hold when parsed as decimals; ignoredLines[] are excluded from this identity. If you can\'t reconcile, prefer UNKNOWN/EXPENSE adjustment only for real financial modifiers, never for receipt metadata.',
    '- "storeName" is the store, restaurant, or venue name printed at the top of the receipt. Use the most prominent / largest name (skip branch numbers, addresses, phone numbers). Omit if no clear store identifier exists.',
    '- "category" is the most likely expense category for this receipt. Choose ONE from this fixed list, based on the storeName + line items:',
    '    - food          : restaurants, cafés, bars, supermarkets, convenience stores, takeout, drinks (居酒屋 / カフェ / レストラン / コンビニ / スーパー / 食堂)',
    '    - transport     : trains, taxis, buses, flights, fuel, parking, tolls, IC card top-ups (タクシー / JR / 地下鉄 / バス / ガソリン / 駐車場 / Suica)',
    '    - accommodation : hotels, ryokan, hostels, Airbnb, lodging fees (ホテル / 旅館 / 民宿)',
    '    - activity      : tickets, museums, theme parks, tours, experiences, attractions (チケット / 入場料 / ツアー / 美術館)',
    '    - shopping      : clothing, electronics, souvenirs, drugstores, department stores, non-food retail (服 / 雑貨 / お土産 / ドラッグストア / 百貨店)',
    '    - other         : anything that does not clearly fit above (medical, ATM fees, services, mixed receipts where intent is unclear)',
    '  Omit "category" only when truly indeterminable. Prefer guessing over omitting.',
    '- If the receipt is unreadable, return items: [], adjustments: [], ignoredLines: [] and totalText: "0".',
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
    console.warn(`[gemini] unreadable: items=[] total=${parsed.data.totalText}`)
    throw new GeminiError('Receipt unreadable (Gemini returned empty items)', 422)
  }

  console.log(`[gemini] success: items=${parsed.data.items.length} adjustments=${parsed.data.adjustments.length} ignored=${parsed.data.ignoredLines.length} total=${parsed.data.totalText} currency=${parsed.data.currency ?? '?'}`)
  return parsed.data
}
