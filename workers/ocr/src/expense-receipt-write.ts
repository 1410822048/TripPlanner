// workers/ocr/src/expense-receipt-write.ts
// Receipt domain for the expense-write endpoints: assemble the Worker-side
// receipt field from consumed upload intents, then validate it (defense-in-
// depth against malformed Storage metadata). Split out of expense-write.ts
// (P4 boundary extraction) -- pure receipt assembly, no auth / Firestore tx /
// money math. The intent CONSUMPTION (consumeEntityIntents) stays in
// upload-intent.ts; this module only turns already-consumed intents into a
// validated receipt object.
import {
  ExpenseValidationError,
  makeReceiptSchema,
  type ExpenseReceiptOut,
}                               from './expense-validate'
import type { ConsumedIntent } from './upload-intent'

/** Run the Worker-built receipt through `makeReceiptSchema` so the
 *  same path-binding + mime invariants that used to gate the legacy
 *  direct-from-client path still apply to intent-derived receipts.
 *  Defense-in-depth: if Storage metadata ever returns an unexpected
 *  shape (mime drift, path mismatch, etc.) we want a clear
 *  ExpenseValidationError at write time rather than a corrupt
 *  `receipt` field landing in Firestore. */
export function validateBuiltReceipt(
  built:     ReturnType<typeof buildReceiptFromIntents>,
  tripId:    string,
  expenseId: string,
): ExpenseReceiptOut {
  const result = makeReceiptSchema(tripId, expenseId).safeParse(built)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ExpenseValidationError(
      `receipt.${issue.path.join('.')}`,
      `intent-built receipt failed validation: ${issue.message}`,
    )
  }
  return result.data
}

/** Build an ExpenseReceipt-shaped object (path-only) from consumed
 *  intents. Required: at least one intent with kind='full' or kind='pdf'
 *  (the primary blob). Optional: a single thumb. No url/thumbUrl -- the
 *  download token was stripped at consume time; reads go through
 *  getBlob(path/thumbPath) gated by Storage Rules. */
export function buildReceiptFromIntents(consumed: ConsumedIntent[]): {
  path:       string
  type:       string
  thumbPath?: string
} {
  const primary = consumed.find(c => c.kind === 'full' || c.kind === 'pdf')
  if (!primary) {
    throw new ExpenseValidationError(
      'intentIds',
      'must include a full or pdf intent (primary blob missing)',
    )
  }
  const out: {
    path:       string
    type:       string
    thumbPath?: string
  } = {
    path: primary.path,
    type: primary.storage.contentType,
  }
  const thumb = consumed.find(c => c.kind === 'thumb')
  if (thumb) {
    out.thumbPath = thumb.path
  }
  return out
}
