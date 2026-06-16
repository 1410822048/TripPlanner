// Shared schemas for the OCR worker.
//
// Two layers:
//   - Request: what the client posts to /ocr
//   - Response: what we promise to return (also matches the JSON Schema the
//     OCR model is instructed to produce via response_format)
//
// The model's structured-output feature lets us send a JSON Schema and the
// model is forced to match it; we still re-parse with Zod on our side
// because (a) the model occasionally returns extra fields, (b) we want
// runtime type safety, (c) we want to coerce / clean (e.g. amount → int).
//
// Phase B (Expense Adjustment refactor): items are POSITIVE-only line
// totals (pre-discount subtotals). Discount / surcharge / tax / tip
// lines that CHANGE the paid total flow into the new `adjustments[]`
// field with a structured kind + scope hint. Informational receipt
// lines (included tax, payment method, change, receipt number, etc.)
// flow into `ignoredLines[]` so the model has a third bucket instead
// of forcing them into items/adjustments. Negative item amounts are
// rejected at the schema layer — drift between OCR output and
// form/Worker validation would otherwise surface as silent
// SPLIT_PREVIEW_DRIFT failures with no clear root cause.
//
// Money refactor: every monetary field on the wire is now an
// `amountText` / `totalText` decimal string (e.g. "12.34", "500"). The
// client parses to integer minor units via `parseMoneyToMinor` at the
// form→Firestore boundary, so the wire never carries a float subject
// to IEEE-754 drift. The model is instructed to emit raw decimal strings
// matching the currency's fraction digits.
import { z } from 'zod'

// ─── Request ─────────────────────────────────────────────────────────────

// Max base64 payload: 8MB ≈ 6MB raw image. Client receipts are compressed to
// OCR-grade WebP before upload, so this leaves headroom for high-quality
// receipt images and forged-client edge cases while keeping a
// hard ceiling on OCR-model quota / CPU burn from a forged client.
// Cloudflare's plan-level limit is 100MB so without this an
// authenticated attacker could DoS our OCR-model budget.
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024

export const OCR_SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type OcrSupportedImageMimeType = typeof OCR_SUPPORTED_IMAGE_MIME_TYPES[number]

export const OcrRequestSchema = z.object({
  /** base64-encoded image bytes (no data: prefix). */
  image:    z.string()
              .min(100, 'image too small')
              .max(MAX_IMAGE_BASE64_BYTES, 'image too large'),
  /** MIME type of the image. We only allow common photo formats — PDFs
   *  are intentionally rejected (the model can read PDFs but receipts as
   *  PDFs are rare and we want to limit attack surface). Mirrors the
   *  receipt attachment set, because Claude/Qwen OCR paths cannot reliably
   *  consume HEIC/HEIF or PDFs. */
  mimeType: z.enum(OCR_SUPPORTED_IMAGE_MIME_TYPES),
  /** ISO 4217 currency code hint (e.g. 'JPY', 'TWD'). The LLM uses this
   *  as a hint when the receipt itself doesn't show a currency symbol.
   *  Regex enforces the ISO 4217 shape (three uppercase letters) without
   *  pinning the full code set — catches obvious garbage without coupling
   *  to a static list we'd have to maintain. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be 3 uppercase letters').optional(),
})
export type OcrRequest = z.infer<typeof OcrRequestSchema>

// ─── Response ────────────────────────────────────────────────────────────

// Money refactor: OCR emits human-display decimal strings (e.g. "12.34" /
// "500"); the client parses via parseMoneyToMinor(amountText, currency) at
// the form→Firestore boundary so the lossy float round-trip never happens
// on the wire. Canonical contract is `\d+(?:\.\d+)?` (no symbols, no group
// separators) — see buildPrompt() in claude.ts. The preprocess strips
// ASCII commas, full-width commas (FF0C), and spaces as a defensive
// self-heal against LLM drift on receipts with printed thousand separators
// like "¥10,276"; anything else (sign, scientific notation, trailing dot,
// non-digit chars) still throws so we don't silently swallow real bugs.
// max(20) caps absurd lengths.
const AMOUNT_TEXT = z.preprocess(
  v => (typeof v === 'string' ? v.replace(/[,，\s]/g, '') : v),
  z.string().regex(/^\d+(?:\.\d+)?$/, 'amountText must be a positive decimal string').max(20),
)

export const OcrItemSchema = z.object({
  name: z.string().min(1).max(200),
  amountText: AMOUNT_TEXT,
})
export type OcrItem = z.infer<typeof OcrItemSchema>

// Expense category enum — kept in lockstep with src/types/expense.ts
// ExpenseCategory. Duplicated (rather than shared) because the worker
// is a separate package with its own tsconfig / deploy artifact, and we
// don't want the worker bundle to drag in client types.
// If you add a value here, mirror it in:
//   - src/types/expense.ts ExpenseCategory
//   - src/features/expense/components/ExpenseFormModal.tsx CATEGORIES
//   - OCR_RESPONSE_JSON_SCHEMA below
export const OcrCategorySchema = z.enum([
  'food',
  'transport',
  'accommodation',
  'activity',
  'shopping',
  'other',
])
export type OcrCategory = z.infer<typeof OcrCategorySchema>

// Adjustment kind / scope enums — mirror of the persisted
// ExpenseAdjustment shape (src/types/expense.ts + the materializer
// package). Duplicated here because the Worker bundle should not pull
// the client types module.
export const OcrAdjustmentKindSchema = z.enum([
  'DISCOUNT', 'COUPON', 'TAX_EXEMPT', 'SURCHARGE', 'TAX', 'TIP', 'OTHER',
])
export type OcrAdjustmentKind = z.infer<typeof OcrAdjustmentKindSchema>

/** OCR-only scope hint. Persisted adjustments only carry `ITEM` /
 *  `EXPENSE`; `UNKNOWN` here signals "the model saw an adjustment but
 *  couldn't confidently decide if it targets a single line or the whole
 *  receipt". The client form downgrades UNKNOWN to EXPENSE by default
 *  and exposes the adjustment row so the user can switch to ITEM when
 *  the receipt makes the target clear. */
export const OcrAdjustmentScopeSchema = z.enum(['ITEM', 'EXPENSE', 'UNKNOWN'])
export type OcrAdjustmentScope = z.infer<typeof OcrAdjustmentScopeSchema>

export const OcrAdjustmentSchema = z.object({
  /** Free-form label visible on the receipt (e.g. "クーポン", "サービス料"). */
  label: z.string().min(1).max(120),
  /** Structured classification. Drives the +/- sign in the materializer
   *  (DISCOUNT/COUPON/TAX_EXEMPT/OTHER subtract; SURCHARGE/TAX/TIP add). */
  kind: OcrAdjustmentKindSchema,
  /** Positive decimal string. Negative effect is encoded via `kind` in
   *  the materializer pipeline; an attacker submitting a negative here
   *  would flip the sign for a kind like TAX, which the regex rejects. */
  amountText: AMOUNT_TEXT,
  /** Hint for the persisted scope: ITEM if the line clearly belongs to a
   *  single item (e.g. an itemised discount immediately under that item),
   *  EXPENSE if it's a receipt-wide line (subtotal-level tax, receipt-wide
   *  service charge), UNKNOWN if the model can't tell. */
  suggestedScope: OcrAdjustmentScopeSchema,
  /** Index into `items[]` when scope is ITEM. Omitted otherwise (the
   *  client resolves UNKNOWN scope to EXPENSE by default in Phase B). */
  suggestedTargetItemIndex: z.number().int().nonnegative().optional(),
})
export type OcrAdjustment = z.infer<typeof OcrAdjustmentSchema>

export const OcrIgnoredLineSchema = z.string().min(1).max(200)
export type OcrIgnoredLine = z.infer<typeof OcrIgnoredLineSchema>

// items can legitimately be empty when the model decides the image is
// unreadable (per our prompt: "if unreadable, return items: [] and
// total: 0"). The worker layer maps the empty case to a distinct error
// so the client can show a "couldn't read" message instead of a
// schema-mismatch one.
export const OcrResponseSchema = z.object({
  items:    z.array(OcrItemSchema),
  /** Adjustment lines extracted from the receipt — discounts, taxes,
   *  service charges, tips. Always present (empty when none); the field
   *  is required so consumers don't have to differentiate "no adjustments"
   *  from "older OCR build". Phase B contract. */
  adjustments: z.array(OcrAdjustmentSchema),
  /** Visible receipt lines that were deliberately ignored because they
   *  do not affect the grand total (included-tax disclosures, payment
   *  method, change, receipt id, address/phone/footer noise). Always
   *  present so the OCR model has a non-financial bucket and does not
   *  misclassify informational tax lines as TAX adjustments. */
  ignoredLines: z.array(OcrIgnoredLineSchema).max(100),
  /** Grand total as a positive decimal string. Client parses via
   *  parseMoneyToMinor(totalText, currency). Empty receipts emit "0". */
  totalText: AMOUNT_TEXT,
  currency: z.string().length(3).optional(),
  /** Store / venue name from the top of the receipt. Optional — some
   *  receipts (printer slips, parking tickets) have no clear store
   *  identifier. Client fills the expense title only when the title
   *  is still empty. */
  storeName: z.string().max(120).optional(),
  /** Inferred expense category based on store type / items. Optional —
   *  the model may omit when the receipt is ambiguous. Client only applies
   *  on new expenses (not edits) and only when present. */
  category: OcrCategorySchema.optional(),
})
export type OcrResponse = z.infer<typeof OcrResponseSchema>

// JSON Schema we hand to Claude's structured-output mode
// (`output_config.format.json_schema.schema`). Kept separate from the Zod
// schema because the model wants plain JSON Schema, not Zod. The shape mirrors
// OcrResponseSchema — if you add a field here, add it there too.
//
// Claude structured-output rules (load-bearing):
//   - EVERY object must carry `additionalProperties: false` (required).
//   - Optional fields are simply omitted from `required` — NOT made nullable,
//     and the model may omit them from the response (matches the Zod
//     `.optional()` fields). No `null` is emitted, so Zod `.optional()` is fine.
//   - NO `propertyOrdering` / min-max / length constraints (unsupported); the
//     model emits required fields first, then optional — order doesn't matter
//     to our Zod parse.
export const OCR_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type:  'array',
      items: {
        type: 'object',
        properties: {
          name:       { type: 'string' },
          amountText: { type: 'string' },
        },
        required: ['name', 'amountText'],
        additionalProperties: false,
      },
    },
    adjustments: {
      type:  'array',
      items: {
        type: 'object',
        properties: {
          label:  { type: 'string' },
          kind:   {
            type: 'string',
            enum: ['DISCOUNT', 'COUPON', 'TAX_EXEMPT', 'SURCHARGE', 'TAX', 'TIP', 'OTHER'],
          },
          amountText: { type: 'string' },
          suggestedScope: {
            type: 'string',
            enum: ['ITEM', 'EXPENSE', 'UNKNOWN'],
          },
          suggestedTargetItemIndex: { type: 'number' },
        },
        required: ['label', 'kind', 'amountText', 'suggestedScope'],
        additionalProperties: false,
      },
    },
    ignoredLines: {
      type:  'array',
      items: { type: 'string' },
    },
    totalText: { type: 'string' },
    currency:  { type: 'string' },
    storeName: { type: 'string' },
    category:  {
      type: 'string',
      enum: ['food', 'transport', 'accommodation', 'activity', 'shopping', 'other'],
    },
  },
  required: ['items', 'adjustments', 'ignoredLines', 'totalText'],
  additionalProperties: false,
} as const
