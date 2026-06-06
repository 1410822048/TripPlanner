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
 *  same URL/path-binding + mime invariants that used to gate the
 *  legacy direct-from-client path still apply to intent-derived
 *  receipts. Defense-in-depth: if Storage metadata ever returns an
 *  unexpected shape (token missing, mime drift, etc.) we want a clear
 *  ExpenseValidationError at write time rather than a corrupt
 *  `receipt` field landing in Firestore. */
export function validateBuiltReceipt(
  built:     ReturnType<typeof buildReceiptFromIntents>,
  tripId:    string,
  expenseId: string,
  bucket:    string,
): ExpenseReceiptOut {
  const result = makeReceiptSchema(tripId, expenseId, bucket).safeParse(built)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ExpenseValidationError(
      `receipt.${issue.path.join('.')}`,
      `intent-built receipt failed validation: ${issue.message}`,
    )
  }
  return result.data
}

/** Build an ExpenseReceipt-shaped object from consumed intents.
 *  Required: at least one intent with kind='full' or kind='pdf' (the
 *  primary blob). Optional: a single thumb. Throws on a missing
 *  download token (the Firebase Storage SDK adds these on every
 *  upload, so missing means non-SDK upload path -- defense-in-depth
 *  against malformed object metadata). */
export function buildReceiptFromIntents(consumed: ConsumedIntent[]): {
  url:        string
  path:       string
  type:       string
  thumbUrl?:  string
  thumbPath?: string
} {
  const primary = consumed.find(c => c.kind === 'full' || c.kind === 'pdf')
  if (!primary) {
    throw new ExpenseValidationError(
      'intentIds',
      'must include a full or pdf intent (primary blob missing)',
    )
  }
  if (!primary.downloadUrl) {
    throw new ExpenseValidationError(
      'intentIds',
      `primary upload at ${primary.path} has no Firebase Storage download token`,
    )
  }
  const out: {
    url:        string
    path:       string
    type:       string
    thumbUrl?:  string
    thumbPath?: string
  } = {
    url:  primary.downloadUrl,
    path: primary.path,
    type: primary.storage.contentType,
  }
  const thumb = consumed.find(c => c.kind === 'thumb')
  if (thumb) {
    if (!thumb.downloadUrl) {
      throw new ExpenseValidationError(
        'intentIds',
        `thumb upload at ${thumb.path} has no Firebase Storage download token`,
      )
    }
    out.thumbUrl  = thumb.downloadUrl
    out.thumbPath = thumb.path
  }
  return out
}
