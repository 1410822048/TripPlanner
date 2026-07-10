// workers/ocr/src/wish-deadline-sweep.ts
// Frequent cron (every 5 min — see wrangler.jsonc): stamp
// wishVotingDeadlineNotifiedAt on any trip whose wishVotingDeadlineAt has
// passed. That write is the ONLY trigger for the Wish-deadline-closed
// notification — firebase-functions' notifyTripRootWrite already watches
// every trips/{tripId} write, and normalizeTripRootWrite's
// wishVotingDeadlineNotifiedAt null→Timestamp branch turns this stamp into
// a `wish.deadline_closed` push for free. This module does nothing beyond
// the stamp; no Cloud Scheduler / Firebase scheduled function needed.
import {
  queryWishDeadlineSweepCandidates,
  stampWishDeadlineNotifiedIfUnchanged,
  readTimestampMs,
  stripDocPrefix,
}                                            from './firestore'
import { getAdminToken, getProjectId }      from './admin'

/** Page size for the trips query. Real installs have very few trips with
 *  an active deadline at any given moment — this just bounds the worst case. */
const PAGE_SIZE = 200

/** This cron runs every 5 minutes (unlike receipt-purge's daily cadence),
 *  so a much shorter soft deadline is enough — whatever doesn't finish
 *  gets picked up on the next pass a few minutes later. */
const SOFT_DEADLINE_MS = 4 * 60 * 1000

export interface WishDeadlineSweepReport {
  scanned:     number
  notified:    number
  deadlineHit: boolean
}

/**
 * Page through trips where wishVotingDeadlineAt <= now AND
 * wishVotingDeadlineNotifiedAt is still null, stamping the latter. Returns
 * a summary report — the cron handler logs it for observability.
 */
export async function sweepWishVotingDeadlines(
  serviceAccountJson: string,
): Promise<WishDeadlineSweepReport> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const nowMs = Date.now()
  const startedAt = Date.now()
  const report: WishDeadlineSweepReport = { scanned: 0, notified: 0, deadlineHit: false }

  let cursorDocName:      string | undefined
  let cursorDeadlineMs:   number | undefined

  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      break
    }

    const page = await queryWishDeadlineSweepCandidates(
      accessToken,
      projectId,
      nowMs,
      PAGE_SIZE,
      cursorDocName,
      cursorDeadlineMs,
    )
    if (page.docs.length === 0) break

    for (const doc of page.docs) {
      report.scanned += 1
      const path = stripDocPrefix(doc.name, projectId)

      // The query's updateTime is the compare-and-set token. Any owner write
      // between query and PATCH (including extending/clearing the deadline)
      // makes this precondition fail benignly, so no stale notification stamp
      // can land and the remaining candidates continue processing.
      const stamped = await stampWishDeadlineNotifiedIfUnchanged(
        accessToken,
        projectId,
        path,
        doc.updateTime,
        new Date().toISOString(),
      )
      if (stamped) report.notified += 1
    }

    if (page.docs.length < PAGE_SIZE) break
    const last = page.docs[page.docs.length - 1]
    cursorDocName = last.name
    cursorDeadlineMs = readTimestampMs(last.fields, 'wishVotingDeadlineAt')
    if (cursorDeadlineMs == null) break
  }

  return report
}
