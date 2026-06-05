// workers/ocr/src/storage.ts
// Thin GCS REST client for the two operations the cascade-trip-delete +
// receipt-purge endpoints need:
//   - listObjects(prefix)  paginated list of object names under a prefix
//   - deleteObject(path)   delete a single object (404 swallowed by caller)
//
// We target storage.googleapis.com/storage/v1 (admin GCS API), NOT
// firebasestorage.googleapis.com — the Firebase wrapper API takes
// Firebase ID tokens (user-scoped), while the admin OAuth token we mint
// in admin.ts authenticates against the raw GCS API. Firebase Admin SDK
// does the same translation under the hood.
const BASE = 'https://storage.googleapis.com/storage/v1'

// Firestore-style no-cache: subrequest results are point-in-time facts
// where staleness would mean leaking deleted objects on the next pass.
const NO_CACHE: RequestInit = { cache: 'no-store' }

export interface StorageObject {
  /** Full object path within the bucket, e.g. `trips/abc/expenses/xyz/receipt.webp`. */
  name: string
  /** RFC 3339 timestamp when the object was created. Populated by GCS
   *  when our partial-response fields include `timeCreated`. Optional
   *  on the interface because some call sites (trip-cascade,
   *  receipt-purge) don't read it -- only the orphan storage-scan
   *  cron needs the age for its 24h grace window check. */
  timeCreated?: string
  /** Custom metadata attached at upload time. The storage-scan cron
   *  reads `metadata.uploaderUid` to attribute orphan blobs back to
   *  the uploading user (Phase 2 abuse detection). Populated by GCS
   *  when our partial-response fields include `metadata` -- a flat
   *  string-string map matches GCS REST shape (`object.metadata` is
   *  always `Record<string, string>`). */
  metadata?: Record<string, string>
}

export interface ListObjectsPage {
  items: StorageObject[]
  nextPageToken?: string
}

/**
 * List a single page of objects under `prefix`. Caller paginates by
 * threading `nextPageToken` back in. pageSize is capped at 1000 by GCS;
 * we default to 500 to keep memory bounded per response (each object is
 * ~240 bytes of JSON metadata with timeCreated included). The orphan
 * storage-scan cron explicitly passes 1000 to halve its round-trip
 * count for the large-prefix daily scan.
 */
export async function listObjects(
  accessToken: string,
  bucket:      string,
  prefix:      string,
  pageToken?:  string,
  pageSize:    number = 500,
): Promise<ListObjectsPage> {
  const url = new URL(`${BASE}/b/${encodeURIComponent(bucket)}/o`)
  url.searchParams.set('prefix', prefix)
  url.searchParams.set('maxResults', String(pageSize))
  // `timeCreated` added so the orphan storage-scan can apply its grace
  // window without a per-object metadata fetch. `metadata` carries the
  // customMetadata.uploaderUid that the abuse-detection step attributes
  // orphan counts to. Trip-cascade + receipt-purge ignore both -- ~70
  // bytes per item extra, well under the 1000-item page budget.
  url.searchParams.set('fields', 'items(name,timeCreated,metadata),nextPageToken')
  if (pageToken) url.searchParams.set('pageToken', pageToken)

  const res = await fetch(url, {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`listObjects ${prefix} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as {
    items?: { name: string; timeCreated?: string; metadata?: Record<string, string> }[]
    nextPageToken?: string
  }
  return {
    items: (data.items ?? []).map(i => ({
      name:        i.name,
      timeCreated: i.timeCreated,
      metadata:    i.metadata,
    })),
    nextPageToken: data.nextPageToken,
  }
}

/**
 * Get a single object's metadata. Returns null on 404 (lets callers
 * distinguish "doesn't exist" from "fetch failed"). Throws on any other
 * non-2xx so transient GCS issues bubble up as cron / endpoint errors
 * rather than silently treating them as "missing object".
 *
 * Used by the entity-write endpoints (/booking-file-*, /wish-file-*,
 * /expense-create, /expense-update) to verify the client actually
 * uploaded to the intent's path before we mark the intent used.
 * `customMetadata` is read so the Worker can enforce
 * the intent-vs-upload contract (allowedContentTypes / maxBytes /
 * customMetadata equality) at consume time -- storage.rules is a
 * STABLE GATE only and does not cross-service-read the intent doc,
 * so this is the authoritative intent-bound check, not a redundant
 * defense-in-depth layer.
 *
 * Firebase Storage SDK uploads auto-add a `firebaseStorageDownloadTokens`
 * entry to customMetadata; the Worker reads it to construct the public
 * download URL without holding a service-account signer key.
 */
export async function getObjectMetadata(
  accessToken: string,
  bucket:      string,
  path:        string,
): Promise<ObjectMetadata | null> {
  const url = `${BASE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`
  const res = await fetch(url, {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`getObjectMetadata ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as {
    name:         string
    size:         string        // GCS REST returns size as string
    contentType?: string
    timeCreated?: string
    metadata?:    Record<string, string>
  }
  return {
    name:           data.name,
    size:           Number(data.size),
    contentType:    data.contentType ?? 'application/octet-stream',
    timeCreated:    data.timeCreated,
    customMetadata: data.metadata,
  }
}

export interface ObjectMetadata {
  name:           string
  size:           number
  contentType:    string
  timeCreated?:   string
  customMetadata?: Record<string, string>
}

/**
 * Download an object's raw bytes via the GCS media endpoint (`?alt=media`).
 * Returns null on 404 (caller maps to a not-found error); throws on any
 * other non-2xx so the caller can map to a 502. The returned `contentType`
 * is the GCS-authoritative value (more trustworthy than a Firestore-stored
 * mime). Caller is responsible for the size ceiling — read metadata FIRST
 * (getObjectMetadata.size) to reject oversize before pulling the body, then
 * re-check `bytes.byteLength` here as defence (a metadata/body mismatch
 * shouldn't be possible, but we don't want to hand an unbounded buffer to
 * the OCR step).
 */
export async function downloadObject(
  accessToken: string,
  bucket:      string,
  path:        string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const url = `${BASE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media`
  const res = await fetch(url, {
    ...NO_CACHE,
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`downloadObject ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream'
  const bytes = await res.arrayBuffer()
  return { bytes, contentType }
}

/**
 * Build a Firebase Storage public download URL for `path` given the
 * object's customMetadata.firebaseStorageDownloadTokens. Tokens are
 * comma-separated; we use the first one (Firebase SDK uses any valid
 * token interchangeably).
 *
 * Returns null when the metadata doesn't carry a token. Phase 3.7
 * does NOT tolerate this -- the Worker is the authoritative writer
 * for booking.attachment / wish.image / expense.receipt and the
 * Firestore doc's url field cannot be left empty without violating
 * the entity's Zod schema. All consume callers (the entity-write
 * endpoints) explicitly reject when the URL is null with a 500 /
 * ExpenseValidationError, surfacing the bypass (non-Firebase-SDK
 * direct GCS upload). In practice Firebase Storage SDK uploads
 * always set this token automatically, so null indicates the upload
 * was not made via the Firebase Storage SDK.
 */
export function downloadUrlFromMetadata(
  bucket:        string,
  path:          string,
  customMetadata: Record<string, string> | undefined,
): string | null {
  const tokens = customMetadata?.firebaseStorageDownloadTokens
  if (!tokens) return null
  const firstToken = tokens.split(',')[0]?.trim()
  if (!firstToken) return null
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media&token=${firstToken}`
}

/**
 * Delete a single object. 404 returns `false` (idempotent already-gone),
 * 2xx returns `true`, anything else throws. Caller treats `false` as a
 * non-error — receipt-purge / trip-cascade are both meant to be safely
 * re-runnable.
 */
export async function deleteObject(
  accessToken: string,
  bucket:      string,
  path:        string,
): Promise<boolean> {
  const url = `${BASE}/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}`
  const res = await fetch(url, {
    ...NO_CACHE,
    method:  'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.ok || res.status === 204) return true
  if (res.status === 404) return false
  const detail = await res.text().catch(() => '')
  throw new Error(`deleteObject ${path} → ${res.status}: ${detail.slice(0, 200)}`)
}

/**
 * Walk every object under `prefix` and delete them. Uses pagination so
 * arbitrarily deep prefixes don't OOM. Order is best-effort (GCS list
 * doesn't guarantee any), but it doesn't matter for delete — each call
 * is independent.
 *
 * Returns the count actually deleted (404s don't count).
 */
export async function purgeObjectsByPrefix(
  accessToken: string,
  bucket:      string,
  prefix:      string,
): Promise<number> {
  let deleted   = 0
  let pageToken: string | undefined
  do {
    const page = await listObjects(accessToken, bucket, prefix, pageToken)
    // Sequential delete keeps Worker subrequest pool free for the next
    // list page; trip cascades touch O(dozens) of objects so the latency
    // hit is irrelevant vs. risking pool starvation on parallel deletes.
    for (const obj of page.items) {
      if (await deleteObject(accessToken, bucket, obj.name)) deleted++
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return deleted
}
