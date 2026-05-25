// workers/ocr/src/storage-scan.ts
// Level 4 orphan-blob durability: daily reconciliation cron. Where
// Level 3 (`orphan-purge.ts`) drains a queue of self-reported failures,
// THIS cron catches the things that bypass the queue entirely:
//
//   1. Service-layer process crashes between upload success and the
//      `_purges` enqueue write (rare, but possible on iOS suspend /
//      tab kill mid-await).
//   2. Manual Firebase Console writes / deletes that bypass app logic
//      and so never trigger client-side enqueue.
//   3. Editor abuse via raw SDK loops: editor uploads under random
//      `trips/{tripId}/expenses/RANDOM/blob.webp` paths with no
//      corresponding expense doc; no doc to reference the path, no
//      `_purges` entry, nothing to clean up (until now).
//   4. Future entity types added without wiring `safePurgeWithEnqueueFallback`
//      around them -- this cron is the structural safety net.
//   5. Bytes pre-dating Level 3 entirely (no `_purges` mechanism existed
//      when they were uploaded).
//
// Strategy: page-scan Storage under the `trips/` prefix, parse each
// object's path into (tripId, collection, entityId), apply a 24h grace
// window from `timeCreated`, then for each candidate read the entity
// doc and compare against `referencedPaths()` (same exact-match contract
// as orphan-purge.ts). Per-candidate doc read instead of an upfront
// global path-Set keeps memory bounded at O(page + concurrency) rather
// than O(total references) -- a 1M-reference Set would risk the 128 MB
// Worker limit, especially running parallel to receipt-purge + orphan-
// purge in the same scheduled invocation.
//
// Race-with-upload: 24h grace from `timeCreated` covers mid-upload,
// mid-OCR, retry-after-network-blip, and any other live-flight where
// the entity doc hasn't been written yet. The doc-first wish flow + the
// upload-then-Worker-doc-write expense flow are both well under that.
//
// Race-with-late-reference: a per-candidate re-read of the entity doc
// happens INSIDE the bounded-concurrency worker, AFTER the candidate
// was identified. So if a user re-uploads between the page list and
// the recheck, the recheck sees the new doc.path and we skip the delete.
//
// Fail-closed posture: any Firestore read error (5xx, network, auth)
// → skip + report, do NOT delete. Same invariant as orphan-purge.ts.
// Storage delete failures bubble up to the per-candidate try/catch and
// log; no retry budget (this is a daily cron, tomorrow tries again).
import { listObjects, deleteObject } from './storage'
import { getDocFields, getScanCursor, setScanCursor, clearScanCursor, readString, readTimestampMs } from './firestore'
import { referencedPaths, type ValidCollection } from './orphan-purge'
import { getAdminToken, getProjectId } from './admin'
import { captureMessage } from './sentry'

/** 24-hour grace window from object creation. Covers every realistic
 *  in-flight scenario (multi-second upload retries, OCR pipelines that
 *  take ~10s, user back-grounding mid-flow) without leaving editor-
 *  abuse blobs sitting for weeks. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000

/** Same 14-min soft deadline as the other crons -- Cloudflare cron
 *  trigger hard limit is 15 minutes; bail at 14 and let tomorrow's run
 *  pick up where today's pagination left off (no cross-run cursor
 *  persistence yet; not needed at projected scale). */
const SOFT_DEADLINE_MS = 14 * 60 * 1000

/** GCS list pageSize cap is 1000; scan opts for max to halve round-trip
 *  count vs the default 500 used by trip-cascade / receipt-purge. */
const PAGE_SIZE = 1000

/** In-flight entity rechecks per page batch. Tunes parallelism, NOT
 *  total subrequest count -- the budget gate below is the hard ceiling.
 *  5 is a balance between draining latency and leaving the subrequest
 *  pool free for the next list page. */
const CONCURRENCY = 5

/** Hard cap on this scan's subrequest usage per cron invocation.
 *  Cloudflare cron triggers share a 1000-subrequest budget across all
 *  `ctx.waitUntil` parallel tasks in the same scheduled handler;
 *  receipt-purge and orphan-purge run alongside us, so 300 is the
 *  conservative third-share with 100 left as buffer. CONCURRENCY=5
 *  alone wouldn't help: an all-orphan 1000-item page would issue up to
 *  2000 subrequests (read + delete each) regardless of how many were
 *  in flight at once.
 *
 *  Budget hit alone would starve later pages: a bucket where page 1
 *  is mostly live-referenced (no deletes) would re-read the same head
 *  items every run, never reaching later pages with actual orphans.
 *  Paired with cross-run cursor persistence (`_scanState/storageScan`),
 *  budget exhaustion saves `page.nextPageToken` so tomorrow advances. */
const SUBREQUEST_BUDGET = 300

/** Cross-run cursor staleness: if a saved cursor is older than this,
 *  ignore it and restart from the top. Mostly defensive -- a stale
 *  pageToken from > 1 week ago likely points at a position deep into
 *  a now-much-larger bucket, so resuming from there means head-of-bucket
 *  orphans accumulate unseen. Fresh start is the safer default. */
const CURSOR_STALENESS_MS = 7 * 24 * 60 * 60 * 1000

/** Firestore doc key under `_scanState/{key}` for THIS scan's cursor.
 *  Future scans can reuse the same helpers with different keys. */
const SCAN_KEY = 'storageScan'

/** Abuse-detection threshold: a single uploaderUid producing more than
 *  this many confirmed orphan blobs in one scan run fires a Sentry
 *  warning. Tuned to absorb the realistic "user replaced their receipt
 *  several times" pattern (legitimate, 1-3 orphans) while still
 *  catching raw-SDK loop abuse (typically 100s of orphans in a short
 *  window). Phase 3.5 Final Design pins this at 50/run -- bumped from
 *  the initial 10/run baseline now that we have intent-bound metadata
 *  attribution (legitimate replace-receipt flows hit ~3-5 orphans per
 *  user-week, well below 50). Adjust after observing real baselines.
 *  Note: per RUN, not per day -- a single daily cron invocation -- so
 *  a slow drip across multiple days wouldn't trigger here (caught by
 *  future cumulative analysis if needed). */
const ABUSE_THRESHOLD = 50

/** Storage path under `trips/` that the scan recognizes. Matches the
 *  3 collections that actually hold attachments; anything else (e.g.
 *  a stray manual upload to `trips/X/other/...`) gets counted as
 *  unparseable and skipped -- we don't have a doc schema to verify
 *  it against, so fail-closed: don't delete what we can't reason about. */
const PATH_RE = /^trips\/([^/]+)\/(expenses|bookings|wishes)\/([^/]+)\//

interface ParsedPath {
  tripId:     string
  collection: ValidCollection
  entityId:   string
}

function parsePath(name: string): ParsedPath | null {
  const m = PATH_RE.exec(name)
  if (!m) return null
  return { tripId: m[1]!, collection: m[2] as ValidCollection, entityId: m[3]! }
}

export interface StorageScanReport {
  /** Total objects we paged through (includes unparseable + fresh). */
  scanned:       number
  /** Confirmed orphans we actually deleted. */
  deleted:       number
  /** Skipped: entity doc still references this path -- false alarm. */
  referenced:    number
  /** Skipped: an unexpired pending uploadIntent still claims this blob.
   *  Worker consume hasn't run yet (client crashed mid-finalize / slow
   *  network); blob is temporarily reserved. Treated as defense-in-
   *  depth on top of the 24h grace window: the grace already covers
   *  realistic upload timings, but this gate also covers the rare case
   *  where a blob older than 24h still has a pending intent (e.g.
   *  scheduled cron and upload-intent-purge ran out of order, intent
   *  doc still present despite expiresAt in the past). Worker consume
   *  is the authoritative validator -- this scanner just declines to
   *  delete while consume's input is still discoverable. */
  pendingIntent: number
  /** Skipped: object timeCreated is within the 24h grace window. */
  freshSkipped:  number
  /** Skipped: path doesn't match `trips/X/(expenses|bookings|wishes)/Y/...`
   *  (manual uploads outside the managed prefix, future / legacy
   *  paths). Counted for observability but not deleted. */
  unparseable:   number
  /** Skipped: entity recheck Firestore call threw. Fail-closed --
   *  don't delete what we couldn't verify is orphan. */
  readErrors:    number
  /** Skipped: deleteObject threw on a confirmed orphan. Logged; tomorrow
   *  retries (the object is still discoverable + still orphan). */
  deleteErrors:  number
  /** True if SOFT_DEADLINE_MS hit before exhausting pages. */
  deadlineHit:   boolean
  /** True if SUBREQUEST_BUDGET was hit before exhausting pages.
   *  Distinct from deadlineHit so operators can tell apart "cron took
   *  too long" from "cron used too many fetches" -- different root
   *  causes, different mitigations. */
  budgetHit:     boolean
  /** Orphan blob count attributed to each uploaderUid (read from the
   *  blob's customMetadata.uploaderUid at upload time). Used for abuse
   *  detection: any uid exceeding ABUSE_THRESHOLD fires a Sentry
   *  warning before the cron returns. `'<unknown>'` bucket covers
   *  blobs uploaded before the Phase 2 customMetadata change shipped
   *  (legacy data) or by clients that bypassed metadata somehow. */
  orphansByUid:  Record<string, number>
}

/**
 * Drain orphan blobs under `trips/` in Cloud Storage. See file header
 * for the failure modes this catches and the design rationale.
 *
 * Throws on the entry-level listObjects call failing (run-aborting --
 * no way to enumerate any objects). Per-candidate failures are caught
 * and counted in the report; the cron caller logs the report normally.
 *
 * `opts.subrequestBudget` overrides the default budget cap; tests use
 * this to drive the budget-hit path with small synthetic pages instead
 * of having to stage 300+ items in a fixture.
 */
export async function scanOrphanStorage(
  serviceAccountJson: string,
  bucket:             string,
  opts: {
    subrequestBudget?: number
    /** Sentry env object passed through to captureMessage for abuse
     *  alerts. Optional so the cron can also run from contexts without
     *  a configured DSN (local testing, dev) -- in that case the
     *  threshold-hit branch still fires console.warn but skips Sentry. */
    sentryEnv?:        { SENTRY_DSN?: string }
  } = {},
): Promise<StorageScanReport> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const startedAt   = Date.now()
  const ageCutoffMs = startedAt - MIN_AGE_MS
  const budget      = opts.subrequestBudget ?? SUBREQUEST_BUDGET
  // Shared mutable counter; the pMap workers all see the same object,
  // so race-overshoot is bounded by CONCURRENCY (≤5) -- harmless given
  // the 100-subrequest buffer we leave from the 1000-cron-total.
  const subreq      = { used: 0 }
  const report: StorageScanReport = {
    scanned: 0, deleted: 0, referenced: 0,
    pendingIntent: 0, freshSkipped: 0, unparseable: 0,
    readErrors: 0, deleteErrors: 0,
    deadlineHit: false, budgetHit: false,
    orphansByUid: {},
  }

  // Resume from saved cursor when fresh; otherwise start from the top.
  // Cursor read failure is non-fatal -- worst case we restart this
  // run from the head, which is exactly what would happen on a first
  // ever run anyway.
  let pageToken: string | undefined
  try {
    const cursor = await getScanCursor(accessToken, projectId, SCAN_KEY)
    if (cursor && Date.now() - cursor.savedAtMs < CURSOR_STALENESS_MS) {
      pageToken = cursor.pageToken
    }
  } catch (e) {
    console.warn(`[storage-scan] cursor load failed; starting from top: ${(e as Error).message}`)
  }

  // Track the most recent page so the post-loop cursor save can read
  // its nextPageToken without having to know which branch ended the
  // loop. Reset on each successful list, examined on the way out.
  let lastPage: { nextPageToken?: string } | null = null

  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      break
    }
    // Pre-check before consuming a subrequest. Leave 1 for the list
    // call itself; if even that doesn't fit we're done.
    if (subreq.used + 1 > budget) {
      report.budgetHit = true
      break
    }

    let page
    try {
      subreq.used += 1
      page = await listObjects(accessToken, bucket, 'trips/', pageToken, PAGE_SIZE)
      lastPage = page
    } catch (e) {
      // List failure is run-aborting (no way to discover any further
      // objects). Re-throw with partial counts in the message so the
      // cron's `.catch` log line is informative -- mirrors the
      // orphan-purge cron's pattern for the same failure mode.
      throw new Error(
        `storage-scan listObjects failed mid-scan ` +
        `(scanned=${report.scanned} deleted=${report.deleted} ` +
        `referenced=${report.referenced} freshSkipped=${report.freshSkipped}): ` +
        `${(e as Error).message}`,
      )
    }

    // First-pass filter inside the page: parse + grace window. Anything
    // that survives goes into the candidates list for the bounded-
    // concurrency entity recheck below.
    const candidates: { obj: { name: string; timeCreated?: string; metadata?: Record<string, string> }; parsed: ParsedPath }[] = []
    for (const obj of page.items) {
      report.scanned += 1
      const parsed = parsePath(obj.name)
      if (!parsed) {
        report.unparseable += 1
        continue
      }
      // Without timeCreated we can't compute age. Fail-closed: treat as
      // fresh, don't delete. Shouldn't happen given our partial-response
      // fields request, but defense-in-depth against partial-response
      // glitches.
      const createdMs = obj.timeCreated ? Date.parse(obj.timeCreated) : NaN
      if (!Number.isFinite(createdMs) || createdMs > ageCutoffMs) {
        report.freshSkipped += 1
        continue
      }
      candidates.push({ obj, parsed })
    }

    // Bounded-concurrency entity recheck. Each worker pulls candidates
    // off the shared cursor until depleted; this avoids the all-at-once
    // Promise.all blast that would spike subrequest pool usage above
    // the cron-trigger budget.
    await pMap(candidates, async ({ obj, parsed }) => {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        report.deadlineHit = true
        return
      }
      // Each candidate uses at most 3 subrequests: pending-intent
      // recheck (optional) + entity recheck + optional Storage delete.
      // Reserve all three upfront so we don't start a read we can't
      // finish-and-delete on -- gate identically for still-referenced
      // and delete-needed paths.
      if (subreq.used + 3 > budget) {
        report.budgetHit = true
        return
      }
      try {
        // Pending-intent safety net (Phase 3.5 Final Design section
        // 3B). If the blob carries an intentId and that intent doc
        // still says `status='pending'` with `expiresAt > now`, Worker
        // consume hasn't yet finalised this upload. Skip deletion --
        // either consume will land momentarily, or upload-intent-purge
        // will move it out of pending and the next scan cycle catches
        // it as orphan. Defense-in-depth on top of the 24h grace.
        //
        // Blobs without `metadata.uploadIntentId` (legacy / pre-Phase-
        // 3.5 uploads) fall straight through to the entity check; the
        // entity-recheck contract is unchanged for them.
        const intentId = obj.metadata?.uploadIntentId
        if (intentId && intentId.length === 32) {
          subreq.used += 1
          const intentPath = `trips/${parsed.tripId}/uploadIntents/${intentId}`
          const intentFields = await getDocFields(accessToken, projectId, intentPath)
          if (intentFields !== null) {
            const status      = readString(intentFields, 'status')
            const expiresAtMs = readTimestampMs(intentFields, 'expiresAt')
            if (status === 'pending' && expiresAtMs !== undefined && expiresAtMs > Date.now()) {
              report.pendingIntent += 1
              return
            }
          }
          // intent doc missing / used / expired → fall through to the
          // entity recheck below. Either Worker already consumed it
          // (entity doc should reference the blob) or it's truly
          // abandoned (entity doc absent → real orphan).
        }

        const entityPath = `trips/${parsed.tripId}/${parsed.collection}/${parsed.entityId}`
        subreq.used += 1
        const fields = await getDocFields(accessToken, projectId, entityPath)
        if (fields === null) {
          // Entity doc gone (or never existed -- e.g. editor abuse
          // upload to random entityId). Confirmed orphan, delete.
          subreq.used += 1
          await tryDelete(accessToken, bucket, obj, report)
          return
        }
        // Entity exists -- check exact-match against its current
        // attachment path field(s). referencedPaths is reused from
        // orphan-purge.ts so the contract stays identical across both
        // crons (no drift between Level 3 and Level 4 on what counts
        // as "still in use").
        const refs = referencedPaths(parsed.collection, fields)
        if (refs.has(obj.name)) {
          report.referenced += 1
          return
        }
        // Entity exists but doesn't reference this blob -- the doc was
        // updated to point at a different path (e.g. user replaced the
        // attachment) and the old blob is stranded. Confirmed orphan.
        subreq.used += 1
        await tryDelete(accessToken, bucket, obj, report)
      } catch (e) {
        // Firestore read failure -- treat as transient, fail-closed.
        // Tomorrow's run retries; the blob is still discoverable.
        // Covers both the pending-intent recheck and the entity
        // recheck; either failing means we can't confidently classify
        // this blob, so we leave it.
        report.readErrors += 1
        console.warn(
          `[storage-scan] candidate recheck failed obj=${obj.name}: ${(e as Error).message}`,
        )
      }
    }, CONCURRENCY)

    if (report.deadlineHit) break
    if (report.budgetHit) break
    if (!page.nextPageToken) break
    pageToken = page.nextPageToken
  }

  // Phase 2 abuse detection: any uploaderUid that produced more than
  // ABUSE_THRESHOLD confirmed orphans in this run fires a Sentry
  // `warning`-level event. `'<unknown>'` is excluded -- legacy blobs
  // without metadata accumulate naturally during Phase 2 rollout, and
  // a high <unknown> count is noise, not attributable abuse.
  for (const [uid, count] of Object.entries(report.orphansByUid)) {
    if (uid === '<unknown>') continue
    if (count <= ABUSE_THRESHOLD) continue
    console.error(
      `[storage-scan] abuse pattern: uid=${uid} produced ${count} orphans (threshold ${ABUSE_THRESHOLD})`,
    )
    if (opts.sentryEnv) {
      // Best-effort; sentry.ts swallows its own failures so the cron's
      // success status isn't affected by telemetry hiccups.
      await captureMessage(
        opts.sentryEnv,
        `Storage abuse pattern: uid ${uid} produced ${count} orphan blobs in one scan`,
        'warning',
        { component: 'storage-scan', uid },
        { orphanCount: count, threshold: ABUSE_THRESHOLD, scanRun: new Date(startedAt).toISOString() },
      )
    }
  }

  // Cursor maintenance: budget / deadline hit mid-scan saves NEXT
  // page's token so tomorrow advances past this page's possibly-
  // unprocessed candidates -- the load-bearing fix for the otherwise-
  // starvation case where page 1 is mostly live-referenced blobs and
  // re-reading them each day eats the budget before later pages get
  // a chance. Skipped candidates from a budget-hit page resurface on
  // the next full cycle once we wrap. Natural drain (no break)
  // clears the cursor so the next run starts fresh from the top.
  // Cursor write failures are non-fatal: tomorrow's run still works,
  // just from a less optimal starting point.
  try {
    if (report.budgetHit || report.deadlineHit) {
      if (lastPage?.nextPageToken) {
        await setScanCursor(accessToken, projectId, SCAN_KEY, lastPage.nextPageToken)
      } else {
        // No next page to advance to -- we stopped on the last page
        // anyway. Clear so tomorrow restarts from the top.
        await clearScanCursor(accessToken, projectId, SCAN_KEY)
      }
    } else {
      // Natural drain: all pages exhausted, clear the cursor.
      await clearScanCursor(accessToken, projectId, SCAN_KEY)
    }
  } catch (e) {
    console.warn(`[storage-scan] cursor maintenance failed: ${(e as Error).message}`)
  }

  return report
}

/** Delete one confirmed-orphan blob + attribute the orphan back to its
 *  uploader. deleteObject throws on non-404 failures; we count + log
 *  but don't re-throw (cron continues with remaining candidates;
 *  tomorrow retries failed deletes).
 *
 *  Honors deleteObject's boolean return: `false` means 404 (the blob
 *  was already gone, e.g. trip-cascade or another cron raced us between
 *  list and delete). Don't credit ourselves for those -- it would
 *  inflate the `deleted` stat in a way that misleads "did our scan
 *  actually find orphans?" observability.
 *
 *  Phase 2 uploaderUid attribution: when the blob's customMetadata
 *  carries an uploaderUid, count this orphan against that uid. Blobs
 *  without metadata (legacy / pre-Phase-2 uploads) bucket as
 *  `'<unknown>'` so they don't get attributed to nobody-in-particular. */
async function tryDelete(
  accessToken: string,
  bucket:      string,
  obj:         { name: string; metadata?: Record<string, string> },
  report:      StorageScanReport,
): Promise<void> {
  try {
    if (await deleteObject(accessToken, bucket, obj.name)) {
      report.deleted += 1
      const uploaderUid = obj.metadata?.uploaderUid ?? '<unknown>'
      report.orphansByUid[uploaderUid] = (report.orphansByUid[uploaderUid] ?? 0) + 1
    }
  } catch (e) {
    report.deleteErrors += 1
    console.warn(
      `[storage-scan] delete failed obj=${obj.name}: ${(e as Error).message}`,
    )
  }
}

/** Bounded-concurrency async iterator. Spawns `min(concurrency, items)`
 *  workers, each pulls from a shared cursor until depleted. Plain
 *  Promise.all would blast all candidates at once and overshoot the
 *  cron-trigger subrequest budget on an all-orphan page; this lets us
 *  cap in-flight work without sequential bottleneck. */
async function pMap<T>(
  items:       T[],
  fn:          (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const workerCount = Math.min(concurrency, items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const i = cursor
      cursor += 1
      await fn(items[i]!)
    }
  })
  await Promise.all(workers)
}
