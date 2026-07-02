// workers/ocr/src/firestore.ts
// Thin Firestore REST API client for Worker-authoritative write endpoints:
//   - getDoc/list helpers for authz and trip-scoped projections
//   - batched array transforms for membership ACL projection repair
//   - transactions for cross-document invariants
//
// All calls go through https://firestore.googleapis.com with the
// admin OAuth bearer token from admin.ts. No client SDK — Workers
// runtime can't load the firebase-admin Node package.
const BASE = 'https://firestore.googleapis.com/v1'

function docPath(projectId: string, path: string): string {
  return `projects/${projectId}/databases/(default)/documents/${path}`
}
function fullName(projectId: string, path: string): string {
  return `${BASE}/${docPath(projectId, path)}`
}

// Cloudflare Workers `fetch` may cache GET responses based on the
// upstream Cache-Control header. Firestore admin REST normally sets
// no-store, but we belt-and-suspenders bypass cache explicitly —
// the worker's reads are point-in-time membership checks where
// staleness would be a correctness bug, not a perf gain.
const NO_CACHE: RequestInit = { cache: 'no-store' }

/** Check whether a doc exists at the given path. Returns true on 200,
 *  false on 404, throws on any other status. Used to verify the
 *  invitee really wrote their member doc before we cascade. */
export async function docExists(
  accessToken: string,
  projectId:   string,
  path:        string,
): Promise<boolean> {
  const res = await fetch(fullName(projectId, path), {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 200) return true
  if (res.status === 404) return false
  const detail = await res.text().catch(() => '')
  throw new Error(`docExists ${path} → ${res.status}: ${detail.slice(0, 200)}`)
}

/** Read a doc's `memberIds` array via the REST GET endpoint. Returns
 *  an empty array if the field is missing. Throws on any non-2xx. */
export async function getDocMemberIds(
  accessToken: string,
  projectId:   string,
  path:        string,
): Promise<string[]> {
  const res = await fetch(fullName(projectId, path), {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`getDocMemberIds ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as {
    fields?: {
      memberIds?: {
        arrayValue?: { values?: { stringValue?: string }[] }
      }
    }
  }
  return (data.fields?.memberIds?.arrayValue?.values ?? [])
    .map(v => v.stringValue)
    .filter((v): v is string => typeof v === 'string')
}

/** arrayUnion MULTIPLE values onto a single doc's memberIds field.
 *  Used to seed a freshly-created invitee member doc with the full
 *  trip roster — the invitee couldn't read trip.memberIds at create
 *  time so wrote `[invitee.uid]` only; the owner's same-doc
 *  array-contains listener filter never matches that doc. This call
 *  brings the doc up to the same {full roster} as every other
 *  member doc. Idempotent. */
export async function arrayUnionMembersOnDoc(
  accessToken: string,
  projectId:   string,
  docName:     string,
  memberUids:  string[],
): Promise<void> {
  if (memberUids.length === 0) return
  const res = await fetch(
    `${BASE}/projects/${projectId}/databases/(default)/documents:commit`,
    {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        writes: [{
          transform: {
            document: docName,
            fieldTransforms: [{
              fieldPath: 'memberIds',
              appendMissingElements: {
                values: memberUids.map(u => ({ stringValue: u })),
              },
            }],
          },
        }],
      }),
    },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`arrayUnionMembersOnDoc → ${res.status}: ${detail.slice(0, 200)}`)
  }
}

/** List every document name in a collection. Handles pagination so
 *  large subcollections don't drop docs. Returns the FULL document
 *  resource names (`projects/.../documents/trips/abc/schedules/xyz`)
 *  ready to plug straight into the commit endpoint. */
export async function listDocNames(
  accessToken: string,
  projectId:   string,
  collection:  string,  // e.g. 'trips/abc/schedules'
): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(fullName(projectId, collection))
    // 1000 is Firestore REST's documented max — same single round-trip
    // covers the largest trip we'd realistically see (cascades always
    // run on a single trip's subcollections, never collection-group).
    url.searchParams.set('pageSize', '1000')
    // Only document names needed — `mask.fieldPaths` empty would still
    // return doc bodies. We accept the body cost; collections under a
    // trip stay small (< 200) so the overhead is negligible vs. doing
    // a separate query that strips fields.
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, {
      ...NO_CACHE,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`listDocNames ${collection} → ${res.status}: ${detail.slice(0, 200)}`)
    }
    const data = await res.json() as {
      documents?: { name: string }[]
      nextPageToken?: string
    }
    for (const d of data.documents ?? []) out.push(d.name)
    pageToken = data.nextPageToken
  } while (pageToken)
  return out
}

/** arrayUnion `memberUid` onto every doc's `memberIds` field. Done as
 *  a single Firestore commit when possible (max 500 writes per commit
 *  per the API limit). The transform fieldPath `memberIds` uses
 *  `appendMissingElements` which is the REST equivalent of arrayUnion
 *  in the SDKs — idempotent if uid is already present. */
export async function batchArrayUnionMemberIds(
  accessToken:    string,
  projectId:      string,
  docNames:       string[],
  memberUid:      string,
): Promise<void> {
  if (docNames.length === 0) return
  for (let i = 0; i < docNames.length; i += 500) {
    const chunk = docNames.slice(i, i + 500)
    const writes = chunk.map(name => ({
      transform: {
        document: name,
        fieldTransforms: [
          {
            fieldPath: 'memberIds',
            appendMissingElements: {
              values: [{ stringValue: memberUid }],
            },
          },
        ],
      },
    }))
    const res = await fetch(
      `${BASE}/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ writes }),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`batchArrayUnion → ${res.status}: ${detail.slice(0, 200)}`)
    }
  }
}

/** Strip a departed member (kicked via /member-remove, or self-left via
 *  /member-leave) from a trip's docs in a SINGLE commit per chunk:
 *  `removeAllFromArray(memberIds, memberUid)` on EVERY doc, plus
 *  `removeAllFromArray(votes, memberUid)` carried as a SECOND fieldTransform
 *  on the SAME write for wish docs. Symmetric to `batchArrayUnionMemberIds`
 *  (the add side) -- same 500-writes-per-commit chunking + error shape.
 *
 *  Why votes rides in this commit rather than a follow-up call: the
 *  memberIds strip is the load-bearing ACL removal (must precede the
 *  member-doc delete so collection-group reads can't leak to a departed
 *  user). The wish-votes cleanup is only data-consistency (a departed
 *  member's vote must stop inflating `votes.length`, the wish sort key) --
 *  NOT a read-leak. Running it as its own commit AFTER the memberIds strip
 *  would open a failure window between "ACL already stripped" and "member
 *  doc deleted": a self-leaver who hit it would lose trip visibility (their
 *  own member doc, one of these docs, has had memberIds stripped, so the
 *  /members collection-group query no longer matches it) yet be unable to
 *  retry from the UI, leaving an orphaned removingAt member doc. Same-commit
 *  means votes either lands with the memberIds strip or the whole strip
 *  fails and the caller's retry re-converges -- no new intermediate state.
 *
 *  Idempotent (removeAllFromArray of an absent value is a no-op). Caller
 *  deletes the member doc LAST, after this returns. */
export async function batchStripDepartedMember(
  accessToken:  string,
  projectId:    string,
  docNames:     string[],
  wishDocNames: string[],
  memberUid:    string,
): Promise<void> {
  if (docNames.length === 0) return
  const wishSet = new Set(wishDocNames)
  const removeUid = (fieldPath: string) => ({
    fieldPath,
    removeAllFromArray: { values: [{ stringValue: memberUid }] },
  })
  for (let i = 0; i < docNames.length; i += 500) {
    const chunk = docNames.slice(i, i + 500)
    const writes = chunk.map(name => {
      const fieldTransforms = [removeUid('memberIds')]
      // Wish docs get the votes strip as a second transform on the SAME
      // write -- one touch per doc, atomic with its memberIds strip.
      if (wishSet.has(name)) fieldTransforms.push(removeUid('votes'))
      return { transform: { document: name, fieldTransforms } }
    })
    const res = await fetch(
      `${BASE}/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ writes }),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`batchStripDepartedMember → ${res.status}: ${detail.slice(0, 200)}`)
    }
  }
}

/** Convenience: build a full document resource name from a trip-
 *  scoped path so callers can mix listDocNames results with one-off
 *  refs (e.g. the trip doc itself, which doesn't come from a list). */
export function buildDocName(projectId: string, path: string): string {
  return docPath(projectId, path)
}

// ─── Cascade trip-delete + receipt purge additions ──────────────────

/** Fetch raw `fields` map for a doc. Returns null on 404 (caller decides
 *  whether absent-doc is success or error). Used by trip-cascade to
 *  read `ownerId` and `currency`; by receipt-purge to read receipt paths
 *  off the listing page (which already includes fields). */
export async function getDocFields(
  accessToken: string,
  projectId:   string,
  path:        string,
): Promise<Record<string, FsValue> | null> {
  const res = await fetch(fullName(projectId, path), {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`getDocFields ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as { fields?: Record<string, FsValue> }
  return data.fields ?? {}
}

/**
 * Hard-delete docs in 500-doc commit chunks. Each chunk is a single
 * Firestore commit so it's atomic at chunk granularity; commits across
 * chunks aren't atomic, but the cascade is convergent anyway (re-run
 * picks up remaining docs).
 *
 * `docNames` are FULL Firestore document resource names as returned by
 * `listDocNames` / `buildDocName` — `projects/.../documents/trips/abc/xyz/...`.
 */
export async function batchDeleteDocs(
  accessToken: string,
  projectId:   string,
  docNames:    string[],
): Promise<void> {
  if (docNames.length === 0) return
  for (let i = 0; i < docNames.length; i += 500) {
    const chunk = docNames.slice(i, i + 500)
    const writes = chunk.map(name => ({ delete: name }))
    const res = await fetch(
      `${BASE}/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ writes }),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`batchDeleteDocs → ${res.status}: ${detail.slice(0, 200)}`)
    }
  }
}

const USER_TRIP_NOTIFICATION_DELETE_PAGE_SIZE = 500

async function queryUserTripNotificationDocNames(
  accessToken:        string,
  projectId:          string,
  userUid:            string,
  tripId:             string,
  cursorAfterDocName?: string,
): Promise<string[]> {
  const parent = `projects/${projectId}/databases/(default)/documents/users/${userUid}`
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: 'notifications' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'tripId' },
        op:    'EQUAL',
        value: { stringValue: tripId },
      },
    },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: USER_TRIP_NOTIFICATION_DELETE_PAGE_SIZE,
  }
  if (cursorAfterDocName) {
    structuredQuery.startAt = {
      before: false,
      values: [{ referenceValue: cursorAfterDocName }],
    }
  }

  const res = await fetch(`${BASE}/${parent}:runQuery`, {
    ...NO_CACHE,
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`queryUserTripNotificationDocNames -> ${res.status}: ${detail.slice(0, 200)}`)
  }
  const rows = await res.json() as { document?: { name: string } }[]
  return rows
    .map(row => row.document?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

/** Delete one departed user's notification inbox rows for one trip.
 *  Used by member-remove / member-leave after ACL removal has already
 *  converged. Idempotent: no matching docs means no writes. */
export async function deleteUserTripNotifications(
  accessToken: string,
  projectId:   string,
  userUid:     string,
  tripId:      string,
): Promise<number> {
  let deleted = 0
  let cursorAfterDocName: string | undefined
  while (true) {
    const docNames = await queryUserTripNotificationDocNames(
      accessToken, projectId, userUid, tripId, cursorAfterDocName,
    )
    if (docNames.length === 0) return deleted

    await batchDeleteDocs(accessToken, projectId, docNames)
    deleted += docNames.length

    if (docNames.length < USER_TRIP_NOTIFICATION_DELETE_PAGE_SIZE) return deleted
    cursorAfterDocName = docNames[docNames.length - 1]
  }
}

/**
 * Delete the single doc at `path`. 404 returns silently (caller's
 * idempotent re-run scenario). All other non-2xx throw.
 */
export async function deleteDoc(
  accessToken: string,
  projectId:   string,
  path:        string,
): Promise<void> {
  const res = await fetch(fullName(projectId, path), {
    ...NO_CACHE,
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.ok || res.status === 404) return
  const detail = await res.text().catch(() => '')
  throw new Error(`deleteDoc ${path} → ${res.status}: ${detail.slice(0, 200)}`)
}

/** Firestore REST `Value` shape — partial; only the variants we read. */
export interface FsValue {
  stringValue?:    string
  integerValue?:   string | number
  doubleValue?:    number
  booleanValue?:   boolean
  nullValue?:      null
  timestampValue?: string  // ISO 8601, e.g. '2026-05-20T10:00:00Z'
  arrayValue?:     { values?: FsValue[] }
  mapValue?:       { fields?: Record<string, FsValue> }
}

/** Decode a string field. Returns undefined when missing OR not a string. */
export function readString(fields: Record<string, FsValue> | null | undefined, key: string): string | undefined {
  return fields?.[key]?.stringValue
}

// ─── Receipt-purge: collection-group query + per-doc patch ─────────

export interface QueryPage {
  /** Each doc carries its full Firestore resource name (`name`) and the
   *  `fields` map exactly as REST returned them. Caller decodes fields
   *  via the readString / readTimestampMs helpers. */
  docs: { name: string; fields: Record<string, FsValue> }[]
  nextPageToken?: string
}

/**
 * Page through expense docs that are purge candidates:
 *   receiptPurgedAt == null  AND  deletedAt < cutoff
 *
 * Equality first (matches the index `(receiptPurgedAt ASC, deletedAt
 * ASC)` declared in firestore.indexes.json) so we don't re-scan docs
 * that the cron has already cleaned up — the receiptPurgedAt watermark
 * is set by the cron after Storage + field removal, and that's how a
 * doc exits the candidate set permanently.
 *
 * Cursor uses `startAt(deletedAt, __name__)`: receiptPurgedAt is
 * pinned to null by the equality filter so it doesn't need to appear
 * in the cursor tuple.
 */
export async function queryReceiptPurgeCandidates(
  accessToken:             string,
  projectId:               string,
  deletedAtBeforeMs:       number,
  pageSize:                number,
  cursorAfterDocName?:      string,
  cursorAfterDeletedAtMs?:  number,
): Promise<QueryPage> {
  // /documents:runQuery scopes by parent — for collection-group we set
  // parent to the database root and allDescendants: true on `from`.
  const parent = `projects/${projectId}/databases/(default)/documents`
  const cutoffIso = new Date(deletedAtBeforeMs).toISOString()

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: 'expenses', allDescendants: true }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          // Null check on receiptPurgedAt. MUST be unaryFilter +
          // IS_NULL, NOT fieldFilter + EQUAL + {nullValue}: the
          // latter silently returns ZERO matches against every
          // null-valued doc in the wire protocol (Admin SDK
          // explicitly translates `.where('x','==',null)` to this
          // unary shape for the same reason -- see
          // @google-cloud/firestore/build/src/reference/field-filter-
          // internal.js translation logic). With the create rule
          // forcing presence+null on every new expense, IS_NULL
          // matches every live doc until the cron itself stamps a
          // Timestamp after cleanup -- that's how a doc exits the
          // candidate set permanently.
          {
            unaryFilter: {
              field: { fieldPath: 'receiptPurgedAt' },
              op:    'IS_NULL',
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: 'deletedAt' },
              op:    'LESS_THAN',
              value: { timestampValue: cutoffIso },
            },
          },
        ],
      },
    },
    orderBy: [
      { field: { fieldPath: 'deletedAt' },  direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' },   direction: 'ASCENDING' },
    ],
    limit: pageSize,
  }
  if (cursorAfterDocName && cursorAfterDeletedAtMs != null) {
    structuredQuery.startAt = {
      before: false,
      values: [
        { timestampValue: new Date(cursorAfterDeletedAtMs).toISOString() },
        { referenceValue: cursorAfterDocName },
      ],
    }
  }

  const res = await fetch(`${BASE}/${parent}:runQuery`, {
    ...NO_CACHE,
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`queryReceiptPurgeCandidates → ${res.status}: ${detail.slice(0, 200)}`)
  }
  // runQuery streams an array of { document, readTime, skippedResults }.
  // Empty result still returns [{}], so we filter to docs that actually
  // have a document field.
  const rows = await res.json() as { document?: { name: string; fields?: Record<string, FsValue> } }[]
  const docs = rows
    .filter(r => r.document)
    .map(r => ({
      name:   r.document!.name,
      fields: r.document!.fields ?? {},
    }))
  return { docs }
}

// ─── Upload intent purge: status + age query ──────────────────────

/**
 * Page through uploadIntents that match `status` AND `field < beforeMs`.
 *
 * Used by `purgeExpiredUploadIntents` cron for two passes:
 *   1. expired pending intents (status='pending', expiresAt < cutoff)
 *   2. stale used intents (status='used', usedAt < retention cutoff)
 *
 * Each pass needs its own composite index, declared in
 * firestore.indexes.json:
 *   - uploadIntents (status ASC, expiresAt ASC)
 *   - uploadIntents (status ASC, usedAt ASC)
 *
 * Cursor uses (field, __name__) -- matching the orderBy. Mirrors
 * `queryOrphanPurgeCandidates` + `queryReceiptPurgeCandidates`
 * structurally; one parameterized helper for the two passes keeps
 * the structuredQuery shape in one place.
 */
export async function queryUploadIntents(
  accessToken:              string,
  projectId:                string,
  status:                   'pending' | 'used',
  field:                    'expiresAt' | 'usedAt',
  beforeMs:                 number,
  pageSize:                 number,
  cursorAfterDocName?:      string,
  cursorAfterFieldMs?:      number,
): Promise<QueryPage> {
  const parent     = `projects/${projectId}/databases/(default)/documents`
  const beforeIso  = new Date(beforeMs).toISOString()

  const structuredQuery: Record<string, unknown> = {
    // Phase-3.5-bis: intents live under
    // `trips/{tripId}/uploadIntents/{intentId}`. `allDescendants: true`
    // makes this a collection-group query across every trip's intents
    // subcollection in one pass -- backed by the COLLECTION_GROUP
    // composite indexes declared in firestore.indexes.json.
    from: [{ collectionId: 'uploadIntents', allDescendants: true }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: 'status' },
              op:    'EQUAL',
              value: { stringValue: status },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: field },
              op:    'LESS_THAN',
              value: { timestampValue: beforeIso },
            },
          },
        ],
      },
    },
    orderBy: [
      { field: { fieldPath: field },       direction: 'ASCENDING' },
      { field: { fieldPath: '__name__' },  direction: 'ASCENDING' },
    ],
    limit: pageSize,
  }
  if (cursorAfterDocName && cursorAfterFieldMs != null) {
    structuredQuery.startAt = {
      before: false,
      values: [
        { timestampValue: new Date(cursorAfterFieldMs).toISOString() },
        { referenceValue: cursorAfterDocName },
      ],
    }
  }

  const res = await fetch(`${BASE}/${parent}:runQuery`, {
    ...NO_CACHE,
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`queryUploadIntents → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const rows = await res.json() as { document?: { name: string; fields?: Record<string, FsValue> } }[]
  const docs = rows
    .filter(r => r.document)
    .map(r => ({
      name:   r.document!.name,
      fields: r.document!.fields ?? {},
    }))
  return { docs }
}

// ─── Scan cursor: cross-run pagination state for long-running scans ──

/** Single-doc state held under `/_scanState/{scanKey}` so a budget-
 *  /deadline-bounded scan can resume across cron runs without re-
 *  reading the same head pages every day. Used by the Level 4 storage
 *  reconciliation cron (`storage-scan.ts`) but generic enough that
 *  future bucket-spanning crons can reuse the same shape -- pass a
 *  distinct `scanKey`.
 *
 *  Why a Firestore doc and not Cloudflare KV / Durable Object: every
 *  Worker scan already authenticates to Firestore for the entity
 *  recheck step; reusing that channel means one less binding to
 *  manage in wrangler.toml and one less infrastructure surface to
 *  reason about. The doc is admin-only (no rules `match` block →
 *  default deny on the client), Worker writes via the admin OAuth
 *  token like everything else in this module. */
export interface ScanCursor {
  pageToken: string
  savedAtMs: number
}

/** Read the saved cursor for `scanKey`. Returns null when:
 *   - The doc doesn't exist (first run / freshly cleared).
 *   - Required fields missing (defensive against manual / corrupted writes).
 *  Callers apply a staleness check on `savedAtMs` themselves; this
 *  function only reports what's stored. */
export async function getScanCursor(
  accessToken: string,
  projectId:   string,
  scanKey:     string,
): Promise<ScanCursor | null> {
  const fields = await getDocFields(accessToken, projectId, `_scanState/${scanKey}`)
  if (!fields) return null
  const pageToken = fields.pageToken?.stringValue
  const savedAtMs = readTimestampMs(fields, 'savedAt')
  if (!pageToken || savedAtMs === undefined) return null
  return { pageToken, savedAtMs }
}

/** Upsert the cursor. Direct PATCH without `currentDocument.exists`
 *  guard -- this is upsert semantics by design (no doc on first save,
 *  doc present on subsequent saves; we don't care which). */
export async function setScanCursor(
  accessToken: string,
  projectId:   string,
  scanKey:     string,
  pageToken:   string,
): Promise<void> {
  const path    = `_scanState/${scanKey}`
  const docName = buildDocName(projectId, path)
  const url     = new URL(`${BASE}/${docName}`)
  // Both fields in the mask so the PATCH writes them both; the doc
  // either gets created with these two fields or has its existing
  // pageToken + savedAt overwritten.
  url.searchParams.append('updateMask.fieldPaths', 'pageToken')
  url.searchParams.append('updateMask.fieldPaths', 'savedAt')
  const body = {
    fields: {
      pageToken: { stringValue: pageToken },
      savedAt:   { timestampValue: new Date().toISOString() },
    },
  }
  const res = await fetch(url, {
    ...NO_CACHE,
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`setScanCursor ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
}

/** Delete the cursor. Called when a scan completes naturally (drained
 *  to last page) so the next run starts fresh from the top. Idempotent
 *  -- 404 swallowed by deleteDoc. */
export async function clearScanCursor(
  accessToken: string,
  projectId:   string,
  scanKey:     string,
): Promise<void> {
  await deleteDoc(accessToken, projectId, `_scanState/${scanKey}`)
}

// ─── Orphan-purge: collection-group query over `_purges` ──────────

/**
 * Page through `_purges` queue entries that are due for processing:
 *   createdAt < ageCutoff
 *
 * Replaces the previous O(trips) list-then-iterate scan in
 * orphan-purge.ts. Collection-group runs over all `_purges` subcollections
 * in one query, so empty trips cost nothing — drain cost is now O(actual
 * queue entries) instead of O(trip count).
 *
 * Ordering by createdAt ASC drains oldest-first (fair scheduling) and
 * gives a natural cursor for pagination: bumped-attempts entries keep
 * their original createdAt so they re-surface tomorrow without
 * starving newer entries. Cursor tuple `(createdAt, __name__)` matches
 * the orderBy, identical pattern to queryReceiptPurgeCandidates.
 *
 * Requires the COLLECTION_GROUP-scope index on `_purges.createdAt`
 * declared in firestore.indexes.json fieldOverrides. Without it
 * Firestore returns FAILED_PRECONDITION on first call.
 */
export async function queryOrphanPurgeCandidates(
  accessToken:              string,
  projectId:                string,
  ageCutoffMs:              number,
  pageSize:                 number,
  cursorAfterDocName?:      string,
  cursorAfterCreatedAtMs?:  number,
): Promise<QueryPage> {
  const parent = `projects/${projectId}/databases/(default)/documents`
  const cutoffIso = new Date(ageCutoffMs).toISOString()

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: '_purges', allDescendants: true }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'createdAt' },
        op:    'LESS_THAN',
        value: { timestampValue: cutoffIso },
      },
    },
    orderBy: [
      { field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' },
      { field: { fieldPath: '__name__'  }, direction: 'ASCENDING' },
    ],
    limit: pageSize,
  }
  if (cursorAfterDocName && cursorAfterCreatedAtMs != null) {
    structuredQuery.startAt = {
      before: false,
      values: [
        { timestampValue: new Date(cursorAfterCreatedAtMs).toISOString() },
        { referenceValue: cursorAfterDocName },
      ],
    }
  }

  const res = await fetch(`${BASE}/${parent}:runQuery`, {
    ...NO_CACHE,
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`queryOrphanPurgeCandidates → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const rows = await res.json() as { document?: { name: string; fields?: Record<string, FsValue> } }[]
  const docs = rows
    .filter(r => r.document)
    .map(r => ({
      name:   r.document!.name,
      fields: r.document!.fields ?? {},
    }))
  return { docs }
}

/** Patch a doc with the given fields. updateMask scopes the write to
 *  only the listed fields so unrelated fields aren't touched. Pass
 *  `{ nullValue: null }` in the patch to explicitly set a field to
 *  null (keeps the field present, matching the soft-delete /
 *  receiptPurgedAt convention where queries depend on the field
 *  existing). To DELETE a field instead, use `deleteDocFields`.
 *
 *  Returns `true` when the doc existed and the patch landed,
 *  `false` when the doc was already gone (404 / 412 FAILED_
 *  PRECONDITION). The `currentDocument.exists=true` query param
 *  is LOAD-BEARING: without it Firestore PATCH is upsert
 *  semantics, which means a race between this caller and a
 *  concurrent delete (e.g. trip cascade) would silently resurrect
 *  the doc as a zombie carrying only the patched fields. Callers
 *  treat the `false` return as idempotent no-op. */
export async function updateDocFields(
  accessToken: string,
  projectId:   string,
  path:        string,
  patch:       Record<string, FsValue>,
): Promise<boolean> {
  const fieldPaths = Object.keys(patch)
  if (fieldPaths.length === 0) return true
  const url = new URL(fullName(projectId, path))
  for (const fp of fieldPaths) url.searchParams.append('updateMask.fieldPaths', fp)
  // Disable upsert semantics. See JSDoc above.
  url.searchParams.set('currentDocument.exists', 'true')

  const res = await fetch(url, {
    ...NO_CACHE,
    method:  'PATCH',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: patch }),
  })
  if (res.ok) return true
  // Firestore returns 404 when the doc is absent and we had asked
  // it to exist; some surfaces return 400 with FAILED_PRECONDITION
  // payload. Treat either as "doc gone, idempotent skip".
  if (res.status === 404 || res.status === 412) return false
  if (res.status === 400) {
    const detail = await res.text().catch(() => '')
    if (detail.includes('FAILED_PRECONDITION')) return false
    throw new Error(`updateDocFields ${path} → 400: ${detail.slice(0, 200)}`)
  }
  const detail = await res.text().catch(() => '')
  throw new Error(`updateDocFields ${path} → ${res.status}: ${detail.slice(0, 200)}`)
}

/** Delete one or more top-level fields from a doc. Equivalent to the
 *  SDK's `deleteField()` sentinel — under REST, the trick is to list
 *  the field in `updateMask.fieldPaths` but OMIT it from the request
 *  body's `fields` map. Server interprets "mentioned in mask but absent
 *  from body" as a deletion.
 *
 *  Used by receipt-purge to drop the entire `receipt` object map after
 *  the Storage bytes are gone — setting it to nullValue would clash
 *  with the schema (`receipt: ExpenseReceiptSchema.optional()` accepts
 *  undefined but not null), so the field-deletion path is the only
 *  schema-compatible cleanup.
 *
 *  Returns `true` on successful field deletion, `false` when the doc
 *  was already gone. `currentDocument.exists=true` is critical here
 *  too: an empty-body PATCH on a missing doc would otherwise upsert
 *  an empty zombie doc. */
export async function deleteDocFields(
  accessToken: string,
  projectId:   string,
  path:        string,
  fieldPaths:  string[],
): Promise<boolean> {
  if (fieldPaths.length === 0) return true
  const url = new URL(fullName(projectId, path))
  for (const fp of fieldPaths) url.searchParams.append('updateMask.fieldPaths', fp)
  url.searchParams.set('currentDocument.exists', 'true')
  const res = await fetch(url, {
    ...NO_CACHE,
    method:  'PATCH',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })
  if (res.ok) return true
  if (res.status === 404 || res.status === 412) return false
  if (res.status === 400) {
    const detail = await res.text().catch(() => '')
    if (detail.includes('FAILED_PRECONDITION')) return false
    throw new Error(`deleteDocFields ${path} → 400: ${detail.slice(0, 200)}`)
  }
  const detail = await res.text().catch(() => '')
  throw new Error(`deleteDocFields ${path} → ${res.status}: ${detail.slice(0, 200)}`)
}

/** Decode a string field nested inside a map field. Receipt path /
 *  thumbPath live as `receipt.path` / `receipt.thumbPath` (nested map),
 *  not as top-level scalars — this helper walks one level into the
 *  mapValue so the purge cron can reach them. */
export function readNestedString(
  fields:   Record<string, FsValue> | null | undefined,
  mapKey:   string,
  innerKey: string,
): string | undefined {
  const inner = fields?.[mapKey]?.mapValue?.fields
  return inner?.[innerKey]?.stringValue
}

/** Decode a timestamp field to epoch ms. Returns undefined when missing
 *  OR not a timestamp. Firestore REST returns timestampValue as
 *  ISO 8601 string with optional fractional seconds + 'Z'. */
export function readTimestampMs(fields: Record<string, FsValue> | null | undefined, key: string): number | undefined {
  const iso = fields?.[key]?.timestampValue
  if (typeof iso !== 'string') return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}
