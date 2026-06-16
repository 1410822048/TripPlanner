// Claude receipt OCR client — single-purpose: send a receipt image, get
// structured items[] + adjustments[] + total back.
//
// Provider: Anthropic Claude via MICROSOFT FOUNDRY (Azure AI Foundry). The
// Foundry endpoint speaks the NATIVE Anthropic Messages API
// (`/anthropic/v1/messages`), so this is a normal messages[].content[]
// (image + text) + output_config request — no OpenAI-compat shim.
//
// Why raw fetch (not @anthropic-ai/foundry-sdk):
//   - We only ever call one method (messages.create)
//   - The SDK pulls in a runtime dep tree we don't need
//   - Workers cold-start cost is proportional to bundle size
//   - The REST call is stable and ~40 lines (same rationale as the prior
//     Gemini / Qwen clients this file replaces)
//
// Model: a Foundry DEPLOYMENT of Claude (currently Sonnet 4.6 — switched up
// from Haiku 4.5, which read receipt amounts poorly). The `model` field carries
// the DEPLOYMENT NAME, injected via env (never hardcoded) so a tier swap is one
// var.
//
// Request body is kept TIER-AGNOSTIC on purpose — we send NO `effort` and NO
// `thinking`:
//   - Pure structured extraction needs no reasoning, so omitting them keeps
//     cost / latency down.
//   - It stays valid across every tier: Haiku 4.5 REJECTS `effort` (400),
//     while Sonnet / Opus accept it but we don't need it. Don't add `effort` /
//     `thinking` unless a future task actually benefits.
//
// Structured output: `output_config.format` json_schema with the shared
// OCR_RESPONSE_JSON_SCHEMA (additionalProperties:false on every object). We
// still re-parse with Zod on our side for runtime type safety + coercion.
//
// Auth: Foundry API key in the `x-api-key` header + `anthropic-version`. The
// Foundry resource name (URL host is derived from it) and the deployment name
// come from env so a resource / region / model swap is config, not code. The
// env var names mirror the official Foundry SDK convention
// (`ANTHROPIC_FOUNDRY_RESOURCE` / `ANTHROPIC_FOUNDRY_API_KEY`).
//
// Pricing / quota are EXTERNAL facts (billed through the Azure Marketplace) —
// check current Foundry pricing before assuming the cost of any swap.
import { OcrResponseSchema, OCR_RESPONSE_JSON_SCHEMA, type OcrResponse } from './schema'

const ANTHROPIC_VERSION = '2023-06-01'

// Generous output ceiling. A dense receipt can carry many items[] +
// adjustments[] + ignoredLines[] (capped 100); a too-low max_tokens would
// truncate the JSON → stop_reason='max_tokens' → 422. 4096 covers typical
// receipts with headroom while bounding cost.
const MAX_TOKENS = 4096
export const OCR_PROMPT_VERSION = 'claude-receipt-v3'

/** Per-request Claude/Foundry config, threaded from the Worker env. */
export interface ClaudeConfig {
  /** Foundry API key (secret) — sent as `x-api-key`. */
  apiKey:   string
  /** Foundry resource name (e.g. `aic-claude-eus2`). The endpoint host is
   *  `https://{resource}.services.ai.azure.com/anthropic/v1/messages`. */
  resource: string
  /** Deployment name — goes in the `model` field. NOT necessarily the model id
   *  (e.g. a custom `claude-haiku-4-5-2`); a wrong name is a 404. */
  model:    string
}

// Prompt contract:
//   - system: stable role / non-inference policy.
//   - user text: receipt-domain bucket rules + output details.
// Keep this OCR-first. The model is allowed to classify visible receipt lines,
// but not to invent accounting entries to make totals balance.
export const SYSTEM_PROMPT = [
  'You are a strict receipt OCR extraction engine.',
  'Transcribe only visible receipt evidence into the required JSON schema.',
  'Do not infer hidden taxes, estimate missing discounts, translate labels, correct store math, or invent balancing lines.',
  'When a visible line is not a financial modifier, preserve it in ignoredLines[].',
].join(' ')

export function buildPrompt(currencyHint?: string): string {
  return [
    'Task: extract visible receipt data into a single JSON object.',
    'Treat the receipt photo as the only source of truth.',
    '',
    'Evidence policy:',
    '- Every item, adjustment, ignoredLine, totalText, currency, storeName, and category must be supported by visible text in the image.',
    '- Preserve the original language of each item / adjustment / ignored line exactly (do not translate).',
    '- Do not invent taxes, discounts, tips, service charges, or refund lines just to make arithmetic reconcile.',
    '- If a visible line is ambiguous or informational, put it in ignoredLines[] instead of adjustments[].',
    '',
    'Amount format:',
    '- amountText / totalText wire format: ASCII digits with an optional single dot for the fractional part (e.g. "12.34" for USD, "500" for JPY, "300" for TWD). NO thousand separators (no comma, no space, no full-width comma), NO currency symbols, NO leading sign, NO scientific notation. JPY/KRW/TWD/VND/IDR are zero-fraction currencies — emit integer-only strings for them. Do NOT scale to minor units. Do NOT round; preserve the printed precision.',
    '',
    'Line buckets:',
    '- items[] holds POSITIVE-only purchased product / service line totals printed next to product lines, in the receipt currency.',
    '- Do not put subtotal echoes, grand totals, payment method, cash received, change, receipt numbers, addresses, phone numbers, footer text, or tax disclosure lines in items[].',
    '- adjustments[] holds only visible receipt-wide or per-item modifiers that explicitly CHANGE the amount due: discount / cashback / coupon / tax-exempt (negative effect) AND surcharge / service / added tax / tip (positive effect). amountText on every adjustment is a POSITIVE decimal string; the sign is encoded by `kind`.',
    '    - kind = DISCOUNT | COUPON | TAX_EXEMPT (subtract from receipt total)',
    '    - kind = SURCHARGE | TAX | TIP            (add to receipt total)',
    '    - kind = OTHER                           (use only when the visible line clearly changes the amount due but the kind is truly unclear; it defaults to subtract downstream)',
    '- suggestedScope hints whether the adjustment targets a single item or the whole receipt:',
    '    - ITEM    : printed immediately under / beside one product line ("Donut 200 / 値引 -20")',
    '    - EXPENSE : receipt-wide line (subtotal-level tax, service charge, total discount)',
    '    - UNKNOWN : can\'t tell from layout; pick this only when neither ITEM nor EXPENSE is clearly correct',
    '- suggestedTargetItemIndex is the 0-based index into items[] when scope is ITEM. Omit when scope is EXPENSE or UNKNOWN.',
    '',
    'Adjustment target rules:',
    '- Do not default an adjustment to EXPENSE just because the target item is uncertain.',
    '- Use ITEM when the discount / surcharge line is directly under, beside, or indented inside one product block before the next product / subtotal line.',
    '- For a discount line immediately following one product line and before the next product line, target the previous visible item index.',
    '- Use EXPENSE only when the line is after subtotal / 小計 / 合計, near the payment summary, or the label explicitly indicates a whole-order / whole-receipt / points / campaign adjustment.',
    '- Use UNKNOWN when a visible modifier changes the amount due but neither a single-item anchor nor a receipt-wide anchor is clear. UNKNOWN is safer than EXPENSE.',
    '- Never spread one ambiguous discount across all items by guessing. Never set suggestedTargetItemIndex unless suggestedScope is ITEM and the target index is clear from the visible item order.',
    '- ignoredLines[] holds visible receipt lines that do NOT change the paid total: included-tax disclosures, subtotal echoes, payment method, cash received, change, receipt number, register id, address, phone, and footer text. Preserve the original text.',
    '',
    'Adjustment evidence gate:',
    '- Create an adjustment only when a visible line explicitly changes the amount due.',
    '- Subtracting evidence examples: 値引, 割引, クーポン, ポイント利用, 返金, 還付, TAX FREE DISCOUNT, or a printed minus sign on a discount/refund line.',
    '- Adding evidence examples: サービス料, 手数料, チップ, 送料, 外税, or a 消費税 line explicitly added to a 税抜小計 / subtotal.',
    '- Never emit OTHER/EXPENSE merely to force sum(items) + adjustments to equal totalText.',
    '',
    'Japan / Taiwan tax disclosure hard rules:',
    '- TAX is only for a tax line that is added to a pre-tax subtotal and actually changes the grand total. If item prices already include tax and the receipt merely discloses the included tax amount, put that line in ignoredLines[], not adjustments[].',
    '- On Japanese or Taiwanese receipts, tax figures printed in parentheses — e.g. (内消費税等) ¥0, (内税) ¥N, (消費税) ¥N, (免税) ¥N, (內稅) N — are informational disclosures, not modifiers of the paid total. Put them in ignoredLines[]; never emit an adjustment for those parenthesized tax-disclosure lines.',
    '- Japanese DUTY-FREE (免税) receipts only: the printed line prices AND the 合計/total are usually already tax-free. Lines like 免税取引 / 免税対象額 / (免税) ¥N merely DISCLOSE the tax-free subtotal or the tax the customer saved — they do NOT lower what was paid (the 合計 already excludes that tax). Put every such line in ignoredLines[] and NEVER create a TAX_EXEMPT (or any) adjustment for it — doing so would wrongly subtract the tax a second time. Reserve TAX_EXEMPT only for a rare explicit exemption line that VISIBLY lowers the amount due below the item subtotal.',
    '- Japan/Taiwan included-tax vocabulary: 内税 / 內稅 / 税込 / 含稅 / 軽税 / 軽減税率 usually identify included tax or a reduced-rate category — put them in ignoredLines[] unless the line is explicitly added to a pre-tax subtotal.',
    '',
    'Total selection:',
    '- "totalText" is the receipt grand total / amount due / amount paid by the customer after visible modifiers. Prefer labels such as 合計, お買上げ合計, ご請求額, 領収金額, 支払金額, Total.',
    '- Do not use cash tendered / amount received / change as totalText: お預り, 預り, お釣り, 釣銭, change.',
    '- The identity sum(items[].amountText) + Σ(adjustment sign × adjustment.amountText) should match totalText when the receipt is legible, but NEVER invent an adjustment to make it match. If visible lines do not reconcile, output the best visible extraction and leave metadata in ignoredLines[].',
    '',
    'Store/category:',
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

// Anthropic Messages API response envelope (the subset we read).
interface AnthropicContentBlock {
  type:  string
  text?: string
}
interface AnthropicMessage {
  content?:     AnthropicContentBlock[]
  stop_reason?: string
  // Foundry mirrors Anthropic's error envelope on non-2xx.
  error?:       { type?: string; message?: string }
}

export class OcrError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

function upstreamStatusForClient(status: number): number {
  // Preserve user-actionable retry classes. 429 (rate/quota) passes through;
  // 529 (overloaded) maps to 503 so the client shows "try again later". Every
  // other class (400 bad-body, 401/403 bad-key/RBAC, 404 bad-deployment, 5xx)
  // is an OPERATOR issue with our config — mask as 502 so we don't leak our
  // auth/config state to callers.
  if (status === 429) return 429
  if (status === 529) return 503
  return 502
}

/**
 * Send a base64 image to Claude (via Foundry) and return parsed items[] +
 * adjustments[] + total. Throws OcrError with an HTTP-flavoured status hint:
 *   - 400 → content refused by the model
 *   - 422 → output couldn't be parsed / was empty / truncated
 *   - 502 → network / upstream error / operator config issue (key/deployment/URL)
 *   - 429 → rate-limited / quota exceeded (passed through)
 *   - 503 → upstream overloaded (529 → retry later)
 *
 * Logs go to console (`wrangler tail`, `[claude]` prefix) at every meaningful
 * branch so debugging "why did OCR fail?" doesn't require redeploying.
 */
export async function extractReceiptItems(
  imageBase64: string,
  mimeType:    string,
  currency:    string | undefined,
  cfg:         ClaudeConfig,
): Promise<OcrResponse> {
  const body = {
    model:      cfg.model,
    max_tokens: MAX_TOKENS,
    system:     SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        // Image FIRST, then the instruction — Anthropic's recommended ordering
        // for single-image prompts. media_type must be jpeg/png/gif/webp; the
        // client compresses receipts to WebP, so this is always supported.
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text', text: buildPrompt(currency) },
      ],
    }],
    output_config: {
      format: { type: 'json_schema', schema: OCR_RESPONSE_JSON_SCHEMA },
    },
  }

  const endpoint = `https://${cfg.resource}.services.ai.azure.com/anthropic/v1/messages`
  const t0 = Date.now()
  console.log(`[claude] request: model=${cfg.model} mime=${mimeType} imgBytes~${Math.round(imageBase64.length * 0.75)}`)

  // Explicit subrequest timeout. Workers don't enforce a per-subrequest budget;
  // without this a hung call rides the whole wall-time until the platform kills
  // the worker. 45s is well under Cloudflare's budget and matches the client's
  // 60s patience window.
  let res: Response
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'content-type':     'application/json',
        'x-api-key':        cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError') {
      console.error(`[claude] timeout after 45s`)
      throw new OcrError('Upstream timeout after 45s', 504)
    }
    console.error(`[claude] network error: ${err.message}`)
    throw new OcrError(`Upstream network error: ${err.message}`, 502)
  }

  const elapsed = Date.now() - t0
  console.log(`[claude] response: status=${res.status} elapsed=${elapsed}ms`)

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    console.error(`[claude] error body (truncated): ${detail.slice(0, 500)}`)
    // 400/401/403/404 are almost always OUR config: a malformed request body /
    // bad json_schema (400), a bad/expired ANTHROPIC_FOUNDRY_API_KEY or missing
    // RBAC role (401/403), or a wrong CLAUDE_DEPLOYMENT / base URL (404). Emit a
    // distinct line so it jumps out of wrangler tail — the generic 502 mask
    // otherwise buries the root cause. Client still receives 502.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      console.error(
        `[claude] OPERATOR ATTENTION: Foundry returned ${res.status} — ` +
        `check ANTHROPIC_FOUNDRY_API_KEY / CLAUDE_DEPLOYMENT (deployment name) / ` +
        `ANTHROPIC_FOUNDRY_RESOURCE / RBAC role / region`,
      )
    }
    throw new OcrError(
      `Claude ${res.status}: ${detail.slice(0, 200)}`,
      upstreamStatusForClient(res.status),
    )
  }

  const envelope = await res.json() as AnthropicMessage
  const stop     = envelope.stop_reason
  const textBlock = envelope.content?.find(b => b.type === 'text' && typeof b.text === 'string')
  const text     = textBlock?.text
  console.log(`[claude] stop_reason=${stop ?? '?'} textLen=${text?.length ?? 0}`)

  // Safety refusal — the model declined the image. Distinct from "unreadable".
  if (stop === 'refusal') {
    console.warn(`[claude] content refused`)
    throw new OcrError('Content refused by the model', 400)
  }
  // Output truncated against max_tokens → the JSON is incomplete.
  if (stop === 'max_tokens') {
    console.error(`[claude] response truncated (stop_reason=max_tokens); raise MAX_TOKENS`)
    throw new OcrError('Model output truncated', 422)
  }

  if (typeof text !== 'string') {
    console.error('[claude] no text content in response', JSON.stringify(envelope).slice(0, 500))
    throw new OcrError('Claude returned no text content', 422)
  }

  console.log(`[claude] response text length: ${text.length} chars`)

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new OcrError('Claude returned non-JSON content', 422)
  }

  const parsed = OcrResponseSchema.safeParse(json)
  if (!parsed.success) {
    console.error(`[claude] schema mismatch: ${parsed.error.message.slice(0, 300)}`)
    throw new OcrError(`Schema mismatch: ${parsed.error.message.slice(0, 200)}`, 422)
  }

  // Empty-items branch — the model parsed the prompt correctly and decided it
  // can't read the image. Map to a distinct error so the client shows
  // "看不懂,重拍" instead of a generic schema fail.
  if (parsed.data.items.length === 0) {
    console.warn('[claude] unreadable: items=[]')
    throw new OcrError('Receipt unreadable (model returned empty items)', 422)
  }

  console.log(`[claude] success: items=${parsed.data.items.length} adjustments=${parsed.data.adjustments.length} ignored=${parsed.data.ignoredLines.length}`)
  return parsed.data
}
