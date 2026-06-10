// src/services/attachmentUrlResolver.ts
//
// Phase 2 of the attachment signed-URL migration (see
// docs/design/attachment-signed-url-v2.md). Resolves a Storage object PATH
// to a short-lived GCS V4 signed URL minted by the Worker, instead of the
// getBlob → objectURL path. Returned URLs point straight at
// storage.googleapis.com; there is no blob / objectURL to revoke.
//
// Behind the VITE_ATTACHMENT_URL_MODE flag (default 'getBlob'); the hook
// `useAttachmentUrl` decides whether to call this resolver or getBlob, so
// this module is dead weight until the flag flips. It does NOT fall back to
// getBlob per-request — the flag is the single switch (the rollout plan in
// the design doc §2 deliberately rejects silent per-request degradation).
//
// SECURITY: signed URLs are bearer URLs. They live ONLY in this module's
// memory cache (+ the hook's React state) and are never persisted. The Worker
// re-derives the object path from the Firestore doc for full/pdf, so the
// (tripId/entityType/entityId/variant) we parse from the path here is just a
// LOCATOR the Worker re-validates — a stale client path can't widen access.
import { workerFetch, preflightIdToken, requireWorkerWriteBase } from './workerBase'

export type AttachmentKind = 'thumb' | 'full'

/** Per-kind signed/getBlob switch with a global fallback, read lazily so a
 *  build/test can flip it via env. Precedence: the per-kind var
 *  (VITE_ATTACHMENT_{THUMB,FULL}_URL_MODE) overrides the global
 *  VITE_ATTACHMENT_URL_MODE; anything that isn't 'signed' (incl. unset) is
 *  'getBlob'. The split lets the rollout move full/pdf and thumb
 *  independently — thumb is the higher-traffic path, so they shouldn't be
 *  forced to flip together. */
export function attachmentUrlMode(kind: AttachmentKind): 'getBlob' | 'signed' {
  const perKind = kind === 'thumb'
    ? (import.meta.env.VITE_ATTACHMENT_THUMB_URL_MODE as string | undefined)
    : (import.meta.env.VITE_ATTACHMENT_FULL_URL_MODE  as string | undefined)
  const global = import.meta.env.VITE_ATTACHMENT_URL_MODE as string | undefined
  return (perKind ?? global) === 'signed' ? 'signed' : 'getBlob'
}

/** Resolve the strict Worker base for signed-URL minting, or null. signed
 *  mode mints bearer URLs — a more sensitive call than getBlob — so it
 *  REQUIRES an explicit VITE_WORKER_BASE_URL (same strictness as Worker
 *  writes) rather than silently falling back to the prod Worker: fail-closed
 *  (→ null → placeholder) beats minting prod bearer URLs from a misconfigured
 *  build, and stays correct if staging/prod ever split into separate Firebase
 *  projects. Only reached in signed mode (getBlob never calls the resolver). */
let warnedNoBase = false
function signedBaseOrNull(): string | null {
  try {
    return requireWorkerWriteBase()
  } catch {
    if (import.meta.env.DEV && !warnedNoBase) {
      warnedNoBase = true
      console.warn('[attachmentUrlResolver] signed mode needs VITE_WORKER_BASE_URL; not falling back to prod. Set it, or use getBlob mode.')
    }
    return null
  }
}

/** Re-mint this many ms BEFORE the absolute expiry so an in-use URL is
 *  swapped before GCS would start 403-ing it. Exported for the hook's
 *  refresh timer. */
export const REFRESH_SKEW_MS = 60_000

/** Per-request batch cap on the thumb endpoint (mirrors the Worker's
 *  MAX_THUMB_PATHS). Larger lists are split across multiple requests. */
const THUMB_BATCH_MAX = 20

export interface SignedUrl { url: string; expiresAtMs: number }

// ─── Module cache + epoch ──────────────────────────────────────────
// Keyed by `${kind}:${path}`. full/pdf use the literal path as the key (the
// Worker re-derives the object from the doc, so two callers of the same path
// share one signed URL). A `cacheEpoch` bump (clearSignedUrlCache, on
// sign-out) invalidates every in-flight resolve so a prior user's URL can't
// repopulate the cache for the next user on a shared device.
const cache    = new Map<string, SignedUrl>()
const inFlight = new Map<string, Promise<SignedUrl | null>>()
let cacheEpoch = 0

function keyOf(kind: AttachmentKind, path: string): string { return `${kind}:${path}` }
function isFresh(e: SignedUrl, now: number): boolean { return e.expiresAtMs - now > REFRESH_SKEW_MS }

/** Sync cache peek — used by the hook's initial state so a re-mount of an
 *  already-resolved thumb shows the URL without a null flash. Returns null
 *  unless a still-fresh entry is cached. */
export function peekSignedUrl(path: string, kind: AttachmentKind): SignedUrl | null {
  const e = cache.get(keyOf(kind, path))
  return e && isFresh(e, Date.now()) ? e : null
}

/** Drop every cached signed URL + abandon in-flight resolves. Called by
 *  `clearAttachmentUrlCache()` on sign-out / account switch. */
export function clearSignedUrlCache(): void {
  cacheEpoch += 1
  cache.clear()
  inFlight.clear()
  // Settle any queued-but-not-yet-flushed thumb waiters to null BEFORE
  // dropping the queue. Otherwise the scheduled flush sees an empty batch and
  // returns without resolving them, leaving their resolveSignedUrl(...)
  // promises pending forever (entity resolves don't queue, so they self-settle
  // null via the epoch guard — only the thumb microtask queue has this gap).
  for (const waiters of thumbQueue.values()) {
    for (const w of waiters) w.resolve(null)
  }
  thumbQueue.clear()
}

// ─── Path parsing ──────────────────────────────────────────────────
// Every stored attachment path is `trips/{tripId}/{collection}/{entityId}/
// {file}`. thumb only needs the tripId (to scope the batch request);
// full/pdf needs the full entity ref (the Worker re-derives the path).

function parseTripId(path: string): string | null {
  return /^trips\/([^/]+)\//.exec(path)?.[1] ?? null
}

interface EntityRef { tripId: string; entityType: 'expense' | 'booking' | 'wish'; entityId: string; variant: 'full' | 'pdf' }
function parseEntityRef(path: string): EntityRef | null {
  const m = /^trips\/([^/]+)\/(expenses|bookings|wishes)\/([^/]+)\/(.+)$/.exec(path)
  if (!m) return null
  const [, tripId, collection, entityId, file] = m
  if (!tripId || !collection || !entityId || !file) return null
  const entityType = collection === 'expenses' ? 'expense' : collection === 'bookings' ? 'booking' : 'wish'
  const variant: 'full' | 'pdf' = file.toLowerCase().endsWith('.pdf') ? 'pdf' : 'full'
  return { tripId, entityType, entityId, variant }
}

function toEntry(expiresAt: string, url: string): SignedUrl | null {
  const expiresAtMs = Date.parse(expiresAt)
  return Number.isFinite(expiresAtMs) ? { url, expiresAtMs } : null
}

// ─── Thumb: microtask-batched signer ───────────────────────────────
// Requests in the same tick collapse into one /attachment-thumb-urls call
// (grouped by tripId, chunked at THUMB_BATCH_MAX). queueMicrotask flushes
// after the current synchronous render burst so a list of N thumbnails is
// one round-trip, not N.
interface ThumbWaiter { resolve: (e: SignedUrl | null) => void }
const thumbQueue = new Map<string, ThumbWaiter[]>()   // path -> waiters
let thumbFlushScheduled = false

function enqueueThumb(path: string): Promise<SignedUrl | null> {
  return new Promise(resolve => {
    const waiters = thumbQueue.get(path) ?? []
    waiters.push({ resolve })
    thumbQueue.set(path, waiters)
    if (!thumbFlushScheduled) {
      thumbFlushScheduled = true
      queueMicrotask(() => { void flushThumbs() })
    }
  })
}

async function flushThumbs(): Promise<void> {
  thumbFlushScheduled = false
  const batch = new Map(thumbQueue)
  thumbQueue.clear()
  if (batch.size === 0) return
  const startEpoch = cacheEpoch

  const settle = (path: string, entry: SignedUrl | null): void => {
    if (entry) cache.set(keyOf('thumb', path), entry)
    batch.get(path)?.forEach(w => w.resolve(entry))
  }

  // Group by tripId; paths that don't parse get null immediately.
  const byTrip = new Map<string, string[]>()
  for (const path of batch.keys()) {
    const tripId = parseTripId(path)
    if (!tripId) { settle(path, null); continue }
    const arr = byTrip.get(tripId) ?? []
    arr.push(path); byTrip.set(tripId, arr)
  }
  if (byTrip.size === 0) return

  const base = signedBaseOrNull()
  if (!base) { for (const path of batch.keys()) settle(path, null); return }

  let token: string
  try {
    token = await preflightIdToken()
  } catch {
    for (const path of batch.keys()) settle(path, null)
    return
  }

  await Promise.all([...byTrip.entries()].map(async ([tripId, paths]) => {
    for (let i = 0; i < paths.length; i += THUMB_BATCH_MAX) {
      const chunk = paths.slice(i, i + THUMB_BATCH_MAX)
      let urls: Array<{ path: string; url: string; expiresAt: string }> = []
      try {
        const res = await workerFetch(base, token, '/attachment-thumb-urls', { tripId, paths: chunk })
        urls = (res as { urls?: typeof urls }).urls ?? []
      } catch {
        // leave urls empty → every path in the chunk resolves null below
      }
      const got = new Map(urls.map(u => [u.path, u]))
      const stale = cacheEpoch !== startEpoch   // cleared (sign-out) mid-flight
      for (const path of chunk) {
        const u = got.get(path)
        settle(path, stale || !u ? null : toEntry(u.expiresAt, u.url))
      }
    }
  }))
}

// ─── Entity full/pdf: single signer ────────────────────────────────

async function fetchEntityUrl(path: string): Promise<SignedUrl | null> {
  const ref = parseEntityRef(path)
  if (!ref) return null
  const base = signedBaseOrNull()
  if (!base) return null
  const startEpoch = cacheEpoch
  let token: string
  try {
    token = await preflightIdToken()
  } catch {
    return null
  }
  try {
    const res = await workerFetch(base, token, '/attachment-url', {
      tripId: ref.tripId, entityType: ref.entityType, entityId: ref.entityId, variant: ref.variant,
    }) as { url?: string; expiresAt?: string }
    if (cacheEpoch !== startEpoch || !res.url || !res.expiresAt) return null
    const entry = toEntry(res.expiresAt, res.url)
    if (entry) cache.set(keyOf('full', path), entry)
    return entry
  } catch {
    return null
  }
}

// ─── Public resolve ────────────────────────────────────────────────

/** Resolve a path to a signed URL (+ absolute expiry), or null on any
 *  failure. Serves a fresh cache hit synchronously-ish (resolved promise);
 *  de-dups concurrent resolves of the same key; thumb requests in one tick
 *  batch into a single Worker call. */
export function resolveSignedUrl(path: string, kind: AttachmentKind): Promise<SignedUrl | null> {
  const key = keyOf(kind, path)
  const cached = cache.get(key)
  if (cached && isFresh(cached, Date.now())) return Promise.resolve(cached)

  const existing = inFlight.get(key)
  if (existing) return existing

  const p = (kind === 'thumb' ? enqueueThumb(path) : fetchEntityUrl(path))
    .finally(() => { if (inFlight.get(key) === p) inFlight.delete(key) })
  inFlight.set(key, p)
  return p
}
