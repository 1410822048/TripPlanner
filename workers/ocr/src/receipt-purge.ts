// workers/ocr/src/receipt-purge.ts
// Daily cron: for every expense that has been soft-deleted for more
// than 10 days, drop the Storage receipt (image + thumbnail) and clear
// the URL/path fields on the doc.
//
// Why the 10-day delay:
//   - Settlement chronological replay (phase-2) needs the deletedAt
//     tombstone to classify orphans. The tombstone DOC stays forever;
//     only the receipt bytes get purged for storage hygiene.
//   - 10 days gives the user ample window to restore an accidentally
//     deleted expense before the receipt is gone (restore UI is
//     planned but not yet shipped — once it lands, the 10-day window
//     becomes the practical undo horizon).
//
// Cron handler runs once / day (UTC 03:00 — globally low-traffic hour).
// We page-scan instead of loading everything in memory: Workers cap
// at ~128MB and an unbounded scan could legitimately match thousands
// of expired docs on a long-running install.
import {
  queryReceiptPurgeCandidates,
  deleteDocFields,
  updateDocFields,
  readNestedString,
  readTimestampMs,
  type FsValue,
}                                            from './firestore'
import { deleteObject }                      from './storage'
import { getAdminToken, getProjectId }       from './admin'

/** How long after soft-delete we keep receipts. Constant lives here so
 *  index.ts (cron wiring) and tests can reference the same value. */
export const RECEIPT_RETENTION_MS = 10 * 24 * 3600 * 1000

/** Page size for the collection-group query. 200 keeps each page's
 *  in-memory footprint small (~50 KB of doc metadata) while amortising
 *  the runQuery round-trip across plenty of work per request. */
const PAGE_SIZE = 200

/** Soft deadline before the cron's wall-clock budget runs out. Workers
 *  scheduled handlers have a hard 15-min limit; bail at 14min and let
 *  tomorrow's cron pick up the rest — the filter naturally matches
 *  whatever wasn't processed (deletedAt < cutoff doesn't change unless
 *  someone restores the expense in between, in which case the doc
 *  rightfully falls out of the scan). */
const SOFT_DEADLINE_MS = 14 * 60 * 1000

export interface PurgeReport {
  scanned:         number
  receiptsDeleted: number
  docsPatched:     number
  /** Whether the soft deadline fired (vs. natural end of scan). Lets
   *  the cron log surface "we left some work" without crying wolf. */
  deadlineHit:     boolean
}

/**
 * Page through expenses where deletedAt < (now − 10d), drop receipts,
 * patch docs to clear receipt URLs. Returns a summary report — the
 * cron handler logs it for observability.
 *
 * `bucket` is the Firebase Storage bucket name (e.g.
 * `tripplanner-80a4f.firebasestorage.app`); passed in so this module
 * stays env-agnostic and testable in isolation.
 */
export async function purgeExpiredReceipts(
  serviceAccountJson: string,
  bucket:             string,
): Promise<PurgeReport> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const cutoffMs = Date.now() - RECEIPT_RETENTION_MS
  const startedAt = Date.now()
  const report: PurgeReport = {
    scanned: 0, receiptsDeleted: 0, docsPatched: 0, deadlineHit: false,
  }

  let cursorDocName:     string | undefined
  let cursorTimestampMs: number | undefined

  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      break
    }

    const page = await queryReceiptPurgeCandidates(
      accessToken,
      projectId,
      cutoffMs,
      PAGE_SIZE,
      cursorDocName,
      cursorTimestampMs,
    )
    if (page.docs.length === 0) break

    for (const doc of page.docs) {
      report.scanned += 1
      const path = stripDocPrefix(doc.name, projectId)

      // Receipt lives as a NESTED map: receipt.{url,path,type,thumbUrl,
      // thumbPath}. Reading top-level `doc.fields.receiptPath` would
      // always be undefined -- the silent no-op that shipped before.
      // readNestedString walks one level into the mapValue.
      const receiptPath      = readNestedString(doc.fields, 'receipt', 'path')
      const receiptThumbPath = readNestedString(doc.fields, 'receipt', 'thumbPath')

      if (receiptPath) {
        if (await deleteObject(accessToken, bucket, receiptPath)) {
          report.receiptsDeleted += 1
        }
      }
      if (receiptThumbPath) {
        if (await deleteObject(accessToken, bucket, receiptThumbPath)) {
          report.receiptsDeleted += 1
        }
      }

      // Two-step write because the operations have different schema
      // semantics:
      //   1. Drop the WHOLE `receipt` map (field deletion via mask-no-
      //      body). Setting `receipt: null` would clash with the Zod
      //      schema (`ExpenseReceiptSchema.optional()` accepts
      //      undefined but not null) and break subsequent client reads.
      //   2. Stamp `receiptPurgedAt` as a Timestamp so the filtered
      //      query (`receiptPurgedAt == null AND deletedAt < cutoff`)
      //      excludes this doc forever. Without the stamp the cron
      //      would re-scan every cleaned tombstone daily — O(all
      //      historical deletions) per run.
      // Step 1 only runs when there was actually a receipt to drop;
      // step 2 ALWAYS runs (a doc that matched the query but had no
      // receipt still needs the marker so it's excluded next time).
      //
      // Both PATCH helpers carry `currentDocument.exists=true` and
      // return `false` when the doc has already been deleted between
      // the query and the patch (race with concurrent trip cascade).
      // In that case there's nothing left to mark or clean -- skip
      // to the next doc instead of double-counting `docsPatched`.
      if (receiptPath || receiptThumbPath) {
        const stillThere = await deleteDocFields(accessToken, projectId, path, ['receipt'])
        if (!stillThere) continue
      }
      const stampPatch: Record<string, FsValue> = {
        receiptPurgedAt: { timestampValue: new Date().toISOString() },
      }
      const stampLanded = await updateDocFields(accessToken, projectId, path, stampPatch)
      if (!stampLanded) continue
      report.docsPatched += 1
    }

    // Advance the cursor to the last doc on this page so the next
    // runQuery starts where we left off. Skip if the page returned
    // fewer than PAGE_SIZE — we're at end of scan and another query
    // would just re-fetch zero rows.
    if (page.docs.length < PAGE_SIZE) break
    const last = page.docs[page.docs.length - 1]
    cursorDocName     = last.name
    cursorTimestampMs = readTimestampMs(last.fields, 'deletedAt')
    // Defensive: if the cursor ts is somehow missing, abort rather than
    // restart from the beginning (which would loop forever). This
    // shouldn't happen because we just queried `deletedAt < cutoff`, but
    // if Firestore ever returned a doc without the field we'd loop.
    if (cursorTimestampMs == null) break
  }

  return report
}

/** Strip the `projects/<id>/databases/(default)/documents/` prefix from
 *  a full document resource name so callers using path-based helpers
 *  (`fullName(projectId, path)`) can target it. The REST endpoints we
 *  pass results from emit full resource names; updateDocFields takes
 *  a trip-scoped path. */
function stripDocPrefix(fullName: string, projectId: string): string {
  const prefix = `projects/${projectId}/databases/(default)/documents/`
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName
}
