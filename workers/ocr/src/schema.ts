// Shared schemas for the OCR worker.
//
// Two layers:
//   - Request: what the client posts to /ocr
//   - Response: what we promise to return (also matches what Gemini is
//     instructed to produce via responseJsonSchema)
//
// Gemini's structured-output feature lets us send a JSON Schema and the
// model is forced to match it; we still re-parse with Zod on our side
// because (a) the model occasionally returns extra fields, (b) we want
// runtime type safety, (c) we want to coerce / clean (e.g. amount → int).
import { z } from 'zod'

// ─── Request ─────────────────────────────────────────────────────────────

// Max base64 payload: 8MB ≈ 6MB raw image. Client compresses to
// ~200KB WebP via compressImage(), so this is ~30× headroom for
// edge cases (e.g. user bypasses compress path) while keeping a
// hard ceiling on Gemini quota / CPU burn from a forged client.
// Cloudflare's plan-level limit is 100MB so without this an
// authenticated attacker could DoS our Gemini budget.
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024

export const OcrRequestSchema = z.object({
  /** base64-encoded image bytes (no data: prefix). */
  image:    z.string()
              .min(100, 'image too small')
              .max(MAX_IMAGE_BASE64_BYTES, 'image too large'),
  /** MIME type of the image. We only allow common photo formats — PDFs
   *  are intentionally rejected (Gemini can read PDFs but receipts as
   *  PDFs are rare and we want to limit attack surface). Mirrors the
   *  client-side BOOKING_ATTACHMENT_MIME_TYPES + EXPENSE_RECEIPT_MIME_TYPES
   *  (minus PDF). */
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
  /** ISO 4217 currency code hint (e.g. 'JPY', 'TWD'). The LLM uses this
   *  as a hint when the receipt itself doesn't show a currency symbol.
   *  Regex enforces the ISO 4217 shape (three uppercase letters) without
   *  pinning the full code set — catches obvious garbage without coupling
   *  to a static list we'd have to maintain. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be 3 uppercase letters').optional(),
})
export type OcrRequest = z.infer<typeof OcrRequestSchema>

// ─── Response ────────────────────────────────────────────────────────────

export const OcrItemSchema = z.object({
  name: z.string().min(1).max(200),
  // Amount can be negative — discount / cashback / promo lines on a
  // receipt are real items with negative amounts (e.g. "キャッシュレス
  // 還元 -6"). We don't constrain on sign here; the form layer is
  // responsible for sum-equals-total validation, which works the same
  // whether some lines are negative.
  amount: z.number(),
})
export type OcrItem = z.infer<typeof OcrItemSchema>

// Expense category enum — kept in lockstep with src/types/expense.ts
// ExpenseCategory. Duplicated (rather than shared) because the worker
// is a separate package with its own tsconfig / deploy artifact, and we
// don't want the worker bundle to drag in client types.
// If you add a value here, mirror it in:
//   - src/types/expense.ts ExpenseCategory
//   - src/features/expense/components/ExpenseFormModal.tsx CATEGORIES
//   - GEMINI_RESPONSE_SCHEMA below
export const OcrCategorySchema = z.enum([
  'food',
  'transport',
  'accommodation',
  'activity',
  'shopping',
  'other',
])
export type OcrCategory = z.infer<typeof OcrCategorySchema>

// items can legitimately be empty when Gemini decides the image is
// unreadable (per our prompt: "if unreadable, return items: [] and
// total: 0"). The worker layer maps the empty case to a distinct error
// so the client can show a "couldn't read" message instead of a
// schema-mismatch one.
export const OcrResponseSchema = z.object({
  items:    z.array(OcrItemSchema),
  total:    z.number().nonnegative(),
  currency: z.string().length(3).optional(),
  /** Store / venue name from the top of the receipt. Optional — some
   *  receipts (printer slips, parking tickets) have no clear store
   *  identifier. Client fills the expense title only when the title
   *  is still empty. */
  storeName: z.string().max(120).optional(),
  /** Inferred expense category based on store type / items. Optional —
   *  Gemini may omit when the receipt is ambiguous. Client only applies
   *  on new expenses (not edits) and only when present. */
  category: OcrCategorySchema.optional(),
})
export type OcrResponse = z.infer<typeof OcrResponseSchema>

// JSON Schema (OpenAPI subset) we hand to Gemini's responseJsonSchema.
// Kept separate from the Zod schema because Gemini wants plain JSON Schema,
// not Zod. The shape mirrors OcrResponseSchema — if you add a field here,
// add it there too.
export const GEMINI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type:  'array',
      items: {
        type: 'object',
        properties: {
          name:   { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['name', 'amount'],
        propertyOrdering: ['name', 'amount'],
      },
    },
    total:     { type: 'number' },
    currency:  { type: 'string' },
    storeName: { type: 'string' },
    category:  {
      type: 'string',
      enum: ['food', 'transport', 'accommodation', 'activity', 'shopping', 'other'],
    },
  },
  required: ['items', 'total'],
  propertyOrdering: ['items', 'total', 'currency', 'storeName', 'category'],
} as const
