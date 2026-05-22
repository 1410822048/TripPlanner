// workers/ocr/src/orphan-purge.ts
// Daily cron: drain the `trips/{tripId}/_purges` queue. Members enqueue
// here when their in-process Storage cleanup gave up after the local
// retry budget; this cron is the durable next layer that closes the
// "PII orphan blob lives until trip delete" gap.
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
// time to complete naturally before the cron starts racing them.
import {
  listDocNames,
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
 *  type makes referencedPaths' exhaustiveness compile-time. */
type ValidCollection = 'expenses' | 'bookings' | 'wishes'

/** Decode the FsValue map of an entity doc into the set of paths it
 *  currently references via its attachment field. Schema-aware: each
 *  collection stores the path under a different field name.
 *
 *  Schedules deliberately excluded from the type union -- the
 *  parsePurgeEntry validator filters them out at the queue-entry
 *  layer, so the cron never reaches here with a schedule collection.
 *  Keeping the type narrow makes the exhaustiveness compile-time. */
function referencedPaths(
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
 * Drain the orphan-purge queue. Iterates `/trips/{tripId}/_purges` per
 * trip (no collection-group needed at this scale; a future trip count
 * > 1000 would justify switching to runQuery on the collection group).
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

  // List all trips, then iterate their _purges. Trip count is small.
  const tripDocNames = await listDocNames(accessToken, projectId, 'trips')

  for (const tripDocName of tripDocNames) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      report.deadlineHit = true
      break
    }
    // tripDocName is `projects/{pid}/databases/(default)/documents/trips/{tripId}`
    // We need just the relative path for listDocNames below.
    const tripIdMatch = tripDocName.match(/\/trips\/([^/]+)$/)
    if (!tripIdMatch) continue
    const tripId = tripIdMatch[1]

    let purgeDocNames: string[]
    try {
      purgeDocNames = await listDocNames(accessToken, projectId, `trips/${tripId}/_purges`)
    } catch (e) {
      // Subcollection may not exist (no purges enqueued for this
      // trip) -- listDocNames returns [] in that case; an actual
      // error (network / auth) gets propagated to per-trip log
      // and continues with the next trip.
      console.warn(`[orphan-purge] list _purges failed for trip=${tripId}: ${(e as Error).message}`)
      continue
    }

    for (const purgeDocName of purgeDocNames) {
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
          accessToken, projectId, bucket, tripId, purgeDocName, ageCutoffMs, report,
        )
      } catch (e) {
        console.error(
          `[orphan-purge] unrecoverable error processing ${purgeDocName}: ${(e as Error).message}`,
        )
      }
    }
  }

  return report
}

async function processPurgeEntry(
  accessToken:   string,
  projectId:     string,
  bucket:        string,
  tripId:        string,
  purgeDocName:  string,   // full resource name
  ageCutoffMs:   number,
  report:        OrphanPurgeReport,
): Promise<void> {
  // Step 0: read the queue doc itself. A transient read failure here
  // is non-fatal -- we just skip this entry and try again tomorrow;
  // the queue entry stays in place.
  let purgeFields: Record<string, FsValue> | null
  try {
    purgeFields = await getDocFields(accessToken, projectId, stripDocPrefix(purgeDocName, projectId))
  } catch (e) {
    console.warn(`[orphan-purge] read purge doc failed name=${purgeDocName}: ${(e as Error).message}`)
    return
  }
  if (!purgeFields) return  // doc was deleted between list and read

  // Step 1: validate the queue doc shape. parsePurgeEntry returns null
  // for ANY malformed condition (missing fields, bad entityRef pattern,
  // schedule entityRef, path outside entityRef folder, age below
  // cutoff). Null → drop without touching Storage. The "drop on
  // malformed" decision is safe because the rules layer prevents
  // these shapes from being enqueued today; an existing malformed
  // entry must be legacy / manual / corrupted, and we have no safe
  // way to interpret its intent.
  //
  // Skip age-not-yet-old-enough silently (no drop, no log) by
  // distinguishing it from "truly malformed" -- both currently
  // return null from parsePurgeEntry; the createdAtMs-undefined vs
  // createdAtMs-too-recent disambiguation lives inline below.
  const createdAtMs = readTimestampMs(purgeFields, 'createdAt')
  if (createdAtMs !== undefined && createdAtMs > ageCutoffMs) {
    // Fresh entry -- let in-flight retries finish naturally.
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

