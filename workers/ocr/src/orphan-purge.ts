// workers/ocr/src/orphan-purge.ts
// Daily cron: drain the `trips/{tripId}/_purges` queue. Members enqueue
// here when their in-process Storage cleanup gave up after the local
// retry budget; this cron is the durable next layer that closes the
// "PII orphan blob lives until trip delete" gap.
//
// Scan strategy: single Firestore collection-group `runQuery` over the
// `_purges` group, paginated by (createdAt, __name__) ASC. Replaces an
// earlier O(trips) approach that listed every trip doc then per-trip
// listed _purges -- empty trips paid 1 round-trip each, so cron cost
// grew linearly with trip count regardless of actual queue depth. Now
// cost is O(pending queue entries) and unrelated to total trip count.
//
// Per queue entry:
//   1. Read the entity doc named by `entityRef`. If it still references
//      the purge.path (e.g. expense.receipt.path === purge.path), this
//      is a false orphan -- the user re-uploaded between enqueue and
//      now. Drop the queue entry and move on.
//   2. Otherwise the path is genuinely orphan. Delete the Storage
//      object, then delete the queue entry on success.
//   3. On Storage delete failure: bump attempts. After MAX_ATTEMPTS
//      give up + log + delete the queue entry (avoids leaking queue
//      docs forever for a permanently-bad path).
//
// The 1-hour age gate (`createdAt < now - 1h`) gives in-flight retries
// time to complete naturally before the cron starts racing them. The
// gate is enforced at the query level (the runQuery's `where`) AND
// re-checked per-entry as defense-in-depth against clock skew between
// query and process time.
//
// Cross-trip parse safeguard: the tripId used to validate entityRef is
// derived from where the queue doc LIVES (its parent path in the
// resource name), not from a field. A manually-edited queue entry
// under trip-A claiming entityRef points at trip-B will be rejected
// at parsePurgeEntry instead of accidentally letting the cron read
// trip-B's entity to decide trip-A's blob fate.
import {
  queryOrphanPurgeCandidates,
  getDocFields,
  deleteDoc,
  updateDocFields,
  readNestedString,
  readTimestampMs,
  type FsValue,
}                                            from './firestore'
import { deleteObject }                      from './storage'
import { getAdminToken, getProjectId }       from './admin'

/** Don't process queue entries newer than this -- gives in-process
 *  retries a fair window to finish before we race them. */
const MIN_AGE_MS = 60 * 60 * 1000   // 1 hour

/** Cap on per-doc retry budget before we give up and drop the entry.
 *  Permanently-bad paths (e.g. blob deleted manually + queue entry
 *  unreachable to clean) would otherwise re-enter the cron forever. */
const MAX_ATTEMPTS = 10

/** Soft deadline before the cron's wall-clock runs out. Workers
 *  scheduled handlers have a hard 15-min limit; bail at 14min and let
 *  tomorrow's pass drain the rest. */
const SOFT_DEADLINE_MS = 14 * 60 * 1000

export interface OrphanPurgeReport {
  scanned:         number
  blobsDeleted:    number
  falseOrphans:    number
  giveUps:         number
  deadlineHit:     boolean
}

/** Collections the cron knows how to verify against. Schedules
 *  intentionally absent (see firestore.rules + parsePurgeEntry) --
 *  schedule entityRefs are rejected at queue-entry parse, so the
 *  cron never reaches the verification step with one. Narrowing the
 *  type makes referencedPaths' exhaustiveness compile-time.
 *
 *  Also consumed by `storage-scan.ts` (Level 4 reconciliation):
 *  same exact-match contract, same 3 collections, same field-shape
 *  knowledge -- keeping a single source of truth for "which doc
 *  fields hold storage paths" avoids drift when schemas evolve. */
export type ValidCollection = 'expenses' | 'bookings' | 'wishes'

/** Decode the FsValue map of an entity doc into the set of paths it
 *  currently references via its attachment field. Schema-aware: each
 *  collection stores the path under a different field name.
 *
 *  Schedules deliberately excluded from the type union -- the
 *  parsePurgeEntry validator filters them out at the queue-entry
 *  layer, so the cron never reaches here with a schedule collection.
 *  Keeping the type narrow makes the exhaustiveness compile-time.
 *
 *  Exported for reuse by `storage-scan.ts`. */
export function referencedPaths(
  collection: ValidCollection,
  fields:     Record<string, FsValue> | null | undefined,
): Set<string> {
  const out = new Set<string>()
  if (!fields) return out
  if (collection === 'expenses') {
    // expense.receipt.{path,thumbPath}
    const path  = readNestedString(fields, 'receipt', 'path')
    const thumb = readNestedString(fields, 'receipt', 'thumbPath')
    if (path)  out.add(path)
    if (thumb) out.add(thumb)
  } else if (collection === 'bookings') {
    // booking.attachment.{filePath,thumbPath}
    const path  = readNestedString(fields, 'attachment', 'filePath')
    const thumb = readNestedString(fields, 'attachment', 'thumbPath')
    if (path)  out.add(path)
    if (thumb) out.add(thumb)
  } else if (collection === 'wishes') {
    // wish.image.{path,thumbPath}
    const path  = readNestedString(fields, 'image', 'path')
    const thumb = readNestedString(fields, 'image', 'thumbPath')
    if (path)  out.add(path)
    if (thumb) out.add(thumb)
  }
  return out
}

interface ParsedPurgeEntry {
  collection: ValidCollection
  /** Relative entity path: `trips/{tripId}/{collection}/{id}`. */
  entityPath: string
  /** Storage object path the cron is being asked to delete. */
  path:       string
  /** Retry counter at read time. */
  attempts:   number
  /** createdAt epoch ms (already passed the age gate by the time
   *  parse runs, but kept for log context). */
  createdAtMs: number
}

const ENTITY_REF_RE = /^trips\/([^/]+)\/(expenses|bookings|wishes)\/([A-Za-z0-9_-]+)$/

/** Extract the trip id from a `_purges` queue doc's full resource name.
 *  Queue docs live at `trips/{tripId}/_purges/{auto}`; we need the
 *  tripId for parsePurgeEntry's cross-trip safeguard (entityRef's
 *  declared tripId must match the trip the queue doc actually lives
 *  under). Returns null when the regex doesn't match -- caller must
 *  drop the entry without touching Storage. */
const PURGE_DOC_NAME_RE = /\/trips\/([^/]+)\/_purges\/[^/]+$/
function tripIdFromPurgeDocName(docName: string): string | null {
  const m = PURGE_DOC_NAME_RE.exec(docName)
  return m ? m[1]! : null
}

/** Per-batch fetch size for the orphan-purge collection-group query.
 *  Generous enough that current scale (10s of pending entries per
 *  day) drains in one round-trip; pagination kicks in only on the
 *  cron-overflow path (failed runs accumulating queue depth). */
const PAGE_SIZE = 500

/**
 * Validate + extract everything the cron needs from a `_purges` doc.
 * Returns null when the entry is malformed in any way the cron can
 * detect: missing fields, bad entityRef pattern, path outside
 * entityRef folder, schedule entityRef. A null return MUST cause the
 * caller to drop the entry WITHOUT touching Storage -- this is the
 * data-at-rest defense-in-depth against legacy / corrupted / manually-
 * edited queue docs that bypassed the rules layer's enqueue checks.
 *
 * Collapsing the validation here also means the cron loop only has
 * to reason about "parsed.ok? do work : drop" instead of weaving
 * through scattered null-checks + try/catch + path-prefix checks.
 */
function parsePurgeEntry(
  fields:        Record<string, FsValue> | null | undefined,
  ageCutoffMs:   number,
  /** The tripId the cron is currently scanning. parsePurgeEntry
   *  asserts the entityRef's tripId matches -- without this check
   *  a queue entry under trip-A could carry an entityRef pointing
   *  at trip-B (manual Console edit, corrupted data) and the cron
   *  would read trip-B's entity to decide whether to delete trip-B's
   *  blob. Cross-trip parse rejection closes that vector at the
   *  Worker layer (the rules-layer enqueue gate already pins
   *  entityRef tripId via regex, but we defend data-at-rest here
   *  too). */
  expectedTripId: string,
): ParsedPurgeEntry | null {
  if (!fields) return null

  const entityRef = fields.entityRef?.stringValue
  const path      = fields.path?.stringValue
  const createdAtMs = readTimestampMs(fields, 'createdAt')
  const attempts  = Number(fields.attempts?.integerValue ?? fields.attempts?.doubleValue ?? 0)

  if (!entityRef || !path)            return null
  if (createdAtMs === undefined)      return null
  // Age gate: still inside parse so a fresh doc just looks "invalid
  // for now" to the caller. Equivalent to: skip silently.
  if (createdAtMs > ageCutoffMs)      return null

  // entityRef must match the strict pattern. This catches legacy
  // schedule entityRefs (rules block them now but pre-shipped data
  // could exist), random strings from manual Console writes, etc.
  const m = ENTITY_REF_RE.exec(entityRef)
  if (!m) return null

  // Cross-trip check: queue entries live under `trips/{tripId}/_purges`
  // but the entityRef carries a tripId in its string form. Both must
  // agree -- if a queue entry under trip-A claims entityRef points
  // at trip-B, that's a corrupt / manually-edited doc that the cron
  // MUST NOT process (it would otherwise read trip-B's entity and
  // possibly delete trip-B's blob). The rules layer pins this on
  // enqueue, this is the data-at-rest defense.
  if (m[1] !== expectedTripId) return null

  // path must live directly under entityRef's folder. Same invariant
  // the rules enforce on enqueue; defense-in-depth against data-at-
  // rest tampering.
  if (!path.startsWith(entityRef + '/')) return null

  return {
    collection: m[2] as ValidCollection,
    entityPath: entityRef,  // already in `trips/{tripId}/{collection}/{id}` form
    path,
    attempts,
    createdAtMs,
  }
}

/**
 * Drain the orphan-purge queue via a single collection-group runQuery
 * over `_purges` (replacing the previous O(trips) list-then-iterate
 * scan). Trip count no longer factors in -- cost is O(actual queue
 * entries pending). Pagination is cursor-based on (createdAt, __name__)
 * with retry-bumped entries naturally landing past the cursor (their
 * createdAt doesn't advance, but the cursor does, so they re-surface
 * in tomorrow's run rather than re-processing in this one's pages).
 *
 * Index requirement: COLLECTION_GROUP-scope index on `_purges.createdAt`
 * in firestore.indexes.json. **Deploy ordering matters**: ship the
 * index, wait for it to build (Firestore console / firebase deploy
 * --only firestore:indexes), THEN ship the Worker. Calling this
 * function against an unbuilt index returns FAILED_PRECONDITION.
 */
export async function drainOrphanPurges(
  serviceAccountJson: string,
  bucket:             string,
): Promise<OrphanPurgeReport> {
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const startedAt = Date.now()
  const ageCutoffMs = startedAt - MIN_AGE_MS
  const report: OrphanPurgeReport = {
    scanned: 0, blobsDeleted: 0, falseOrphans: 0, giveUps: 0, deadlineHit: false,
  }

  let cursorDocName:    string | undefined
  let cursorCreatedAtMs: number | undefined

  // Outer loop: paginate the runQuery. Each batch processes up to
  // PAGE_SIZE entries; we advance the cursor past the last batch's
  // tail and re-query. Terminates on: empty page, short page (no
  // more data), or soft deadline. Retry-bumped entries from THIS
  // run aren't re-encountered because the cursor advances past them
  // -- they wait for tomorrow's run, same as before.
  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      break
    }

    let page
    try {
      page = await queryOrphanPurgeCandidates(
        accessToken, projectId, ageCutoffMs, PAGE_SIZE,
        cursorDocName, cursorCreatedAtMs,
      )
    } catch (e) {
      // Query failure (missing index pre-build, auth blip, 5xx) is
      // run-aborting: without the query we can't enumerate ANY entries,
      // so swallowing here would mask the entire queue going stale as a
      // phantom "scanned=0" success line in the cron log. Re-throw to
      // the Worker scheduled handler's `.catch` (index.ts) so the run
      // surfaces as `[cron] orphan-purge failed: ...` instead.
      //
      // Encode the partial report into the message so a mid-drain
      // failure (e.g. page 5 of N fails after pages 1-4 cleaned blobs)
      // doesn't lose the per-run accounting -- Cloudflare Workers
      // observability is line-based, so packing the counts here is the
      // cleanest way to keep them visible alongside the failure reason.
      throw new Error(
        `queryOrphanPurgeCandidates failed mid-drain ` +
        `(scanned=${report.scanned} blobsDeleted=${report.blobsDeleted} ` +
        `falseOrphans=${report.falseOrphans} giveUps=${report.giveUps}): ` +
        `${(e as Error).message}`,
      )
    }

    if (page.docs.length === 0) break

    for (const doc of page.docs) {
      if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
        report.deadlineHit = true
        break
      }
      report.scanned += 1
      // Per-entry try/catch: a malformed legacy entry (e.g. schedule
      // entityRef from before the rules tightening) should NOT stop
      // the whole drain. Log + continue; the entry stays in the
      // queue and a future deploy can clean it up manually.
      try {
        await processPurgeEntry(
          accessToken, projectId, bucket,
          doc.name, doc.fields, ageCutoffMs, report,
        )
      } catch (e) {
        console.error(
          `[orphan-purge] unrecoverable error processing ${doc.name}: ${(e as Error).message}`,
        )
      }
    }
    if (report.deadlineHit) break

    // Advance cursor past the last processed doc's (createdAt, name).
    // If the last doc had no usable createdAt, we have no valid cursor
    // -- the parsePurgeEntry path inside processPurgeEntry already
    // dropped it as malformed, but we still need to advance to avoid
    // refetching the same page. Fall back to name-only cursor; the
    // ORDER BY tiebreaker keeps it monotonic.
    const last = page.docs[page.docs.length - 1]!
    cursorCreatedAtMs = readTimestampMs(last.fields, 'createdAt') ?? cursorCreatedAtMs
    cursorDocName     = last.name

    // Short page = no more data. Saves one round-trip on the final
    // empty query.
    if (page.docs.length < PAGE_SIZE) break
  }

  return report
}

async function processPurgeEntry(
  accessToken:    string,
  projectId:      string,
  bucket:         string,
  purgeDocName:   string,                              // full resource name from runQuery
  purgeFields:    Record<string, FsValue>,             // inline from runQuery, no extra read
  ageCutoffMs:    number,
  report:         OrphanPurgeReport,
): Promise<void> {
  // Source of truth for the cross-trip parse safeguard: extract tripId
  // from where the queue doc actually LIVES (its parent path), NOT from
  // the entityRef field. parsePurgeEntry then asserts entityRef's
  // declared tripId matches. A null here means the queue doc's resource
  // name doesn't fit the expected pattern -- almost certainly a manual /
  // corrupted write that we can't reason about; drop it.
  const tripId = tripIdFromPurgeDocName(purgeDocName)
  if (!tripId) {
    console.warn(`[orphan-purge] queue doc name doesn't match trips/X/_purges/Y pattern: ${purgeDocName}`)
    await tryDeletePurgeDoc(accessToken, projectId, purgeDocName)
    return
  }

  // Age gate is enforced at the query level (createdAt < ageCutoff in
  // the runQuery), but defense-in-depth: if a clock skew between query
  // time and process time pulled a fresh doc into the page, skip it.
  // No drop -- it'll re-appear in a future run when actually aged.
  const createdAtMs = readTimestampMs(purgeFields, 'createdAt')
  if (createdAtMs !== undefined && createdAtMs > ageCutoffMs) {
    return
  }
  const parsed = parsePurgeEntry(purgeFields, ageCutoffMs, tripId)
  if (!parsed) {
    console.warn(
      `[orphan-purge] dropping malformed queue entry name=${purgeDocName} ` +
      `(missing fields / bad entityRef / path outside entityRef)`,
    )
    await tryDeletePurgeDoc(accessToken, projectId, purgeDocName)
    return
  }

  // Step 2: is the path still referenced? Read the entity doc and
  // check. Outcomes:
  //   - getDocFields returns null (404)  → entity is gone → confirmed orphan
  //   - getDocFields returns fields      → check; reference present? false orphan : confirmed
  //   - getDocFields throws              → transient (5xx/network/auth) → DO NOT proceed
  //     to delete the blob. Leave the queue entry intact so tomorrow's
  //     cron retries. Without this strictness, a Firestore 5xx blip
  //     would let the cron mistake an active doc's blob for an orphan
  //     and delete a still-referenced file.
  let entityFields: Record<string, FsValue> | null
  try {
    entityFields = await getDocFields(accessToken, projectId, parsed.entityPath)
  } catch (e) {
    console.warn(
      `[orphan-purge] entity read failed entity=${parsed.entityPath} -- leaving queue entry for next run: ${(e as Error).message}`,
    )
    return
  }

  const stillReferenced =
    entityFields !== null
    && referencedPaths(parsed.collection, entityFields).has(parsed.path)

  if (stillReferenced) {
    // False alarm. Drop the queue entry; the path will get cleaned up
    // later if/when the entity actually unlinks it.
    report.falseOrphans += 1
    await tryDeletePurgeDoc(accessToken, projectId, purgeDocName)
    return
  }

  // Step 3: confirmed orphan -- delete the blob.
  let deleted: boolean
  try {
    deleted = await deleteObject(accessToken, bucket, parsed.path)
  } catch (e) {
    // Storage delete failed (5xx, network). Bump attempts and let
    // tomorrow's cron retry.
    const next = parsed.attempts + 1
    if (next >= MAX_ATTEMPTS) {
      console.error(
        `[orphan-purge] giving up tripId=${tripId} path=${parsed.path} after ${MAX_ATTEMPTS} attempts: ${(e as Error).message}`,
      )
      report.giveUps += 1
      await tryDeletePurgeDoc(accessToken, projectId, purgeDocName)
    } else {
      try {
        await updateDocFields(
          accessToken, projectId, stripDocPrefix(purgeDocName, projectId),
          { attempts: { integerValue: String(next) } },
        )
      } catch (updateErr) {
        console.warn(`[orphan-purge] bump-attempts failed: ${(updateErr as Error).message}`)
      }
    }
    return
  }

  if (deleted) report.blobsDeleted += 1
  // Either we deleted the blob (success) OR storage returned 404
  // (already gone). Both cases: drop the queue entry.
  await tryDeletePurgeDoc(accessToken, projectId, purgeDocName)
}

async function tryDeletePurgeDoc(
  accessToken: string,
  projectId:   string,
  docName:     string,
): Promise<void> {
  try {
    await deleteDoc(accessToken, projectId, stripDocPrefix(docName, projectId))
  } catch (e) {
    console.warn(`[orphan-purge] delete purge entry failed: ${(e as Error).message}`)
  }
}

/** Convert `projects/{pid}/databases/(default)/documents/{path}`
 *  back to `{path}`. */
function stripDocPrefix(fullName: string, projectId: string): string {
  const prefix = `projects/${projectId}/databases/(default)/documents/`
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName
}

