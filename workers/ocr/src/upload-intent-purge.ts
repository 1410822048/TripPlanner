// workers/ocr/src/upload-intent-purge.ts
// Daily cron: drain expired + stale upload intents from the
// `uploadIntents` Firestore collection. Runs alongside
// receipt-purge / orphan-purge / storage-scan under the same
// scheduled handler (UTC 03:00).
//
// Two passes, each paginated + budget-bounded:
//   Pass 1 (expired pending): status='pending' AND
//       expiresAt < now - GRACE_MS.
//     Catches intents whose client either never uploaded or never
//     finalized within the 30-min TTL. GRACE_MS gives in-flight
//     uploads / finalize calls a 5-min buffer so the cron doesn't
//     race the legitimate slow path.
//
//   Pass 2 (stale used / retention): status='used' AND
//       usedAt < now - USED_RETENTION_MS.
//     Used intents are kept 7 days for audit / debug visibility
//     before getting cleaned up. The cron handles the deletion --
//     Firestore TTL would also work but split observability across
//     two cleanup mechanisms; keeping it cron-side means stats and
//     failures show up in the same Worker logs / Sentry path as the
//     other three crons.
//
// Why not Firestore TTL: see project-phase35-upload-intent memory.
// Short version: TTL is Console-only config (no git tracking), 12-
// 48h delivery delay vs sub-second cron precision, can't log metrics.
//
// Failure modes:
//   - queryUploadIntents throws mid-run → re-throw with partial
//     counts encoded in the message (mirrors orphan-purge.ts +
//     storage-scan.ts pattern). Caller's `.catch` log line stays
//     informative; tomorrow's run starts fresh.
//   - deleteDoc 404 → not counted as error. The doc was already
//     deleted by another path (concurrent cron retry, manual
//     cleanup); cron is idempotent across these.
//   - Other deleteDoc errors → counted in deleteErrors, cron
//     continues (next entry not blocked).
//   - Soft deadline / budget hit → break, leave the rest for
//     tomorrow's run. The where clause `field < cutoff` is
//     naturally idempotent across runs (entries are deleted as
//     they're processed, so the cursor advances effectively).

import { queryUploadIntents, deleteDoc, readTimestampMs }      from './firestore'
import { getAdminToken, getProjectId }                          from './admin'

/** Grace period past `expiresAt` before deleting a pending intent.
 *  5 min covers the realistic "intent created, client started
 *  uploading slowly, hit Storage close to expiry" window without
 *  the cron racing a legitimate in-flight upload. */
const GRACE_MS = 5 * 60 * 1000

/** Retention window for used intents. 7 days is long enough for
 *  audit / debug investigation of a recent upload session without
 *  letting the collection grow unboundedly. */
const USED_RETENTION_DAYS = 7
const USED_RETENTION_MS   = USED_RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Per-query page size. Each delete = 1 subrequest; SUBREQUEST_BUDGET
 *  bounds total deletes per run, page size just controls the
 *  query/delete cadence. 200 keeps memory comfortable + lets the
 *  budget gate fire mid-page when needed. */
const PAGE_SIZE = 200

/** Same 14-min soft deadline as the other crons (Cloudflare cron
 *  trigger hard limit is 15 min). */
const SOFT_DEADLINE_MS = 14 * 60 * 1000

/** Subrequest budget for this cron's share of the 1000-per-invocation
 *  scheduled-handler pool. Receipt-purge + orphan-purge + storage-scan
 *  also run in parallel; 200 leaves headroom. Each candidate uses 1
 *  subrequest (the delete); the listObjects-style query also counts
 *  as 1 per page. */
const SUBREQUEST_BUDGET = 200

export interface UploadIntentPurgeReport {
  /** Total docs the query returned across both passes. */
  scanned:        number
  /** Pending intents past grace successfully deleted. */
  deletedPending: number
  /** Used intents past retention successfully deleted. */
  deletedUsed:    number
  /** Non-404 deleteDoc errors. 404 (already gone) doesn't count
   *  -- those are idempotent no-ops. */
  deleteErrors:   number
  /** True if SOFT_DEADLINE_MS hit before exhausting both passes. */
  deadlineHit:    boolean
  /** True if SUBREQUEST_BUDGET hit. */
  budgetHit:      boolean
}

/**
 * Drain expired pending + stale used uploadIntents docs. Two passes,
 * each paginated. Returns the per-run report; throws on entry-level
 * query failure with partial counts encoded in the error message.
 *
 * `opts.pageSize` and `opts.subrequestBudget` override the production
 * constants -- tests use small values to drive pagination / budget /
 * deadline paths without staging 200-doc fixtures. Production calls
 * leave them undefined for tuned defaults.
 */
export async function purgeExpiredUploadIntents(
  serviceAccountJson: string,
  opts: {
    pageSize?:         number
    subrequestBudget?: number
  } = {},
): Promise<UploadIntentPurgeReport> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const pageSize         = opts.pageSize         ?? PAGE_SIZE
  const subrequestBudget = opts.subrequestBudget ?? SUBREQUEST_BUDGET

  const startedAt = Date.now()
  const subreq    = { used: 0 }
  const report: UploadIntentPurgeReport = {
    scanned: 0, deletedPending: 0, deletedUsed: 0,
    deleteErrors: 0, deadlineHit: false, budgetHit: false,
  }

  // Pass 1: expired pending. Cutoff includes GRACE_MS so a legitimate
  // in-flight finalize on the boundary doesn't race the cron.
  const pendingCutoffMs = startedAt - GRACE_MS
  await drainPass(
    accessToken, projectId, 'pending', 'expiresAt', pendingCutoffMs,
    startedAt, subreq, pageSize, subrequestBudget, report,
    n => { report.deletedPending += n },
  )
  if (report.deadlineHit || report.budgetHit) return report

  // Pass 2: stale used. Cutoff is `now - USED_RETENTION_MS`.
  const usedCutoffMs = startedAt - USED_RETENTION_MS
  await drainPass(
    accessToken, projectId, 'used', 'usedAt', usedCutoffMs,
    startedAt, subreq, pageSize, subrequestBudget, report,
    n => { report.deletedUsed += n },
  )

  return report
}

/** One purge pass: paginated query → delete each → advance cursor.
 *  Status + field combinations: ('pending', 'expiresAt') or
 *  ('used', 'usedAt'). Each pass uses its own composite index. */
async function drainPass(
  accessToken:    string,
  projectId:      string,
  status:         'pending' | 'used',
  field:          'expiresAt' | 'usedAt',
  cutoffMs:       number,
  startedAt:      number,
  subreq:         { used: number },
  pageSize:       number,
  subrequestBudget: number,
  report:         UploadIntentPurgeReport,
  incrementDeleted: (n: number) => void,
): Promise<void> {
  let cursorDocName:  string | undefined
  let cursorFieldMs:  number | undefined

  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      return
    }
    // Reserve 1 subrequest for this query call.
    if (subreq.used + 1 > subrequestBudget) {
      report.budgetHit = true
      return
    }

    let page
    try {
      subreq.used += 1
      page = await queryUploadIntents(
        accessToken, projectId, status, field, cutoffMs, pageSize,
        cursorDocName, cursorFieldMs,
      )
    } catch (e) {
      // Re-throw with partial counts so the cron's catch log line
      // is informative. Same pattern as orphan-purge / storage-scan.
      throw new Error(
        `purgeExpiredUploadIntents (${status}/${field}) failed mid-scan ` +
        `(scanned=${report.scanned} deletedPending=${report.deletedPending} ` +
        `deletedUsed=${report.deletedUsed} deleteErrors=${report.deleteErrors}): ` +
        `${(e as Error).message}`,
      )
    }

    if (page.docs.length === 0) return

    // Process each doc serially -- delete is just 1 subrequest per
    // entry, no parallelism win that's worth the bookkeeping. Cron
    // throughput isn't the bottleneck.
    for (const doc of page.docs) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        report.deadlineHit = true
        return
      }
      if (subreq.used + 1 > subrequestBudget) {
        report.budgetHit = true
        return
      }
      report.scanned += 1
      // Trim the resource-name prefix to the relative path that
      // deleteDoc expects. Format (Phase 3.5-bis subcollection):
      // projects/{pid}/databases/(default)/documents/trips/{tripId}/uploadIntents/{id}
      const prefix = `projects/${projectId}/databases/(default)/documents/`
      const path   = doc.name.startsWith(prefix) ? doc.name.slice(prefix.length) : doc.name
      try {
        subreq.used += 1
        await deleteDoc(accessToken, projectId, path)
        incrementDeleted(1)
      } catch (e) {
        // 404s are swallowed by deleteDoc itself (treated as already-
        // gone). Any error reaching here is non-404. Count + log;
        // don't break -- one bad doc shouldn't stall the rest.
        report.deleteErrors += 1
        console.warn(`[upload-intent-purge] delete failed ${path}: ${(e as Error).message}`)
      }
    }

    // Short page → no more results.
    if (page.docs.length < pageSize) return

    // Advance cursor past the last doc.
    const last = page.docs[page.docs.length - 1]!
    cursorFieldMs = readTimestampMs(last.fields, field) ?? cursorFieldMs
    cursorDocName = last.name
  }
}
