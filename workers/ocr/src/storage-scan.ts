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
import { getDocFields }              from './firestore'
import { referencedPaths, type ValidCollection } from './orphan-purge'
import { getAdminToken, getProjectId } from './admin'

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

/** In-flight entity rechecks per page batch. Each candidate does at
 *  most 2 subrequests (Firestore read + optional Storage delete). With
 *  Cloudflare's cron-trigger 1000-subrequest budget, even a worst-case
 *  all-orphan page (1000 candidates × 2 = 2000) would blow the limit;
 *  bounded concurrency lets the cron drain incrementally across multiple
 *  daily runs without blowing the budget in any single one. 5 keeps room
 *  for the next list page's call in the same pool. */
const CONCURRENCY = 5

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
}

/**
 * Drain orphan blobs under `trips/` in Cloud Storage. See file header
 * for the failure modes this catches and the design rationale.
 *
 * Throws on the entry-level listObjects call failing (run-aborting --
 * no way to enumerate any objects). Per-candidate failures are caught
 * and counted in the report; the cron caller logs the report normally.
 */
export async function scanOrphanStorage(
  serviceAccountJson: string,
  bucket:             string,
): Promise<StorageScanReport> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const startedAt   = Date.now()
  const ageCutoffMs = startedAt - MIN_AGE_MS
  const report: StorageScanReport = {
    scanned: 0, deleted: 0, referenced: 0,
    freshSkipped: 0, unparseable: 0,
    readErrors: 0, deleteErrors: 0,
    deadlineHit: false,
  }

  let pageToken: string | undefined

  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      break
    }

    let page
    try {
      page = await listObjects(accessToken, bucket, 'trips/', pageToken, PAGE_SIZE)
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
    const candidates: { obj: { name: string; timeCreated?: string }; parsed: ParsedPath }[] = []
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
      try {
        const entityPath = `trips/${parsed.tripId}/${parsed.collection}/${parsed.entityId}`
        const fields = await getDocFields(accessToken, projectId, entityPath)
        if (fields === null) {
          // Entity doc gone (or never existed -- e.g. editor abuse
          // upload to random entityId). Confirmed orphan, delete.
          await tryDelete(accessToken, bucket, obj.name, report)
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
        await tryDelete(accessToken, bucket, obj.name, report)
      } catch (e) {
        // Firestore read failure -- treat as transient, fail-closed.
        // Tomorrow's run retries; the blob is still discoverable.
        report.readErrors += 1
        console.warn(
          `[storage-scan] entity recheck failed obj=${obj.name}: ${(e as Error).message}`,
        )
      }
    }, CONCURRENCY)

    if (report.deadlineHit) break
    if (!page.nextPageToken) break
    pageToken = page.nextPageToken
  }

  return report
}

/** Delete one confirmed-orphan blob. deleteObject throws on non-404
 *  failures; we count + log but don't re-throw (cron continues with
 *  remaining candidates; tomorrow retries failed deletes). */
async function tryDelete(
  accessToken: string,
  bucket:      string,
  name:        string,
  report:      StorageScanReport,
): Promise<void> {
  try {
    await deleteObject(accessToken, bucket, name)
    report.deleted += 1
  } catch (e) {
    report.deleteErrors += 1
    console.warn(
      `[storage-scan] delete failed obj=${name}: ${(e as Error).message}`,
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
