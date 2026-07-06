// src/services/attachmentUrlResolver.ts
//
// Phase 2 of the attachment signed-URL migration (see
// docs/design/attachment-signed-url-v2.md). Resolves a Storage object PATH to
// a short-lived GCS V4 signed URL minted by the Worker, instead of the
// getBlob → objectURL path. Returned URLs point straight at
// storage.googleapis.com; there is no blob / objectURL to revoke.
//
// SIGNED IS FULL/PDF ONLY. Thumbnails stay on getBlob permanently (design §7):
// a signed thumb adds a Worker round-trip on the critical path that getBlob
// doesn't pay (verify + 2 Firestore member reads + RSA sign), measured
// ~1.35s/thumb — not worth it for tiny list images. So this resolver only
// signs entity-ref full/pdf paths; there is no thumb batch queue.
//
// Behind the VITE_ATTACHMENT_URL_MODE flag (default 'getBlob'); the hook
// `useAttachmentUrl` decides whether to call this resolver or getBlob, so this
// module is dead weight until the flag flips. It does NOT fall back to getBlob
// per-request — the flag is the single switch (the rollout plan in the design
// doc §2 deliberately rejects silent per-request degradation).
//
// SECURITY: signed URLs are bearer URLs. They live ONLY in this module's
// memory cache (+ the hook's React state) and are never persisted. The Worker
// re-derives the object path from the Firestore doc, so the
// (tripId/entityType/entityId/variant) we parse from the path here is just a
// LOCATOR the Worker re-validates — a stale client path can't widen access.
import { workerFetch, preflightIdToken, requireWorkerWriteBase } from './workerBase'

export type AttachmentKind = 'thumb' | 'full'

/** Signed/getBlob switch. Thumbnails are PINNED to getBlob (signed thumb was
 *  removed — design §7), so only full/pdf consults VITE_ATTACHMENT_URL_MODE.
 *  Anything that isn't 'signed' (incl. unset) is 'getBlob'. Read lazily so a
 *  build/test can flip it via env. */
export function attachmentUrlMode(kind: AttachmentKind): 'getBlob' | 'signed' {
  if (kind === 'thumb') return 'getBlob'
  return import.meta.env.VITE_ATTACHMENT_URL_MODE === 'signed' ? 'signed' : 'getBlob'
}

/** Resolve the strict Worker base for signed-URL minting, or null. signed mode
 *  mints bearer URLs — a more sensitive call than getBlob — so it REQUIRES an
 *  explicit VITE_WORKER_BASE_URL (same strictness as Worker writes) rather than
 *  silently falling back to the prod Worker: fail-closed (→ null → placeholder)
 *  beats minting prod bearer URLs from a misconfigured build, and stays correct
 *  if staging/prod ever split into separate Firebase projects. Only reached in
 *  signed mode (getBlob never calls the resolver). */
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

/** Re-mint this many ms BEFORE the absolute expiry so an in-use URL is swapped
 *  before GCS would start 403-ing it. Exported for the hook's refresh timer. */
export const REFRESH_SKEW_MS = 60_000

export interface SignedUrl { url: string; expiresAtMs: number }

// ─── Module cache + epoch ──────────────────────────────────────────
// Keyed by the literal object path (the Worker re-derives the object from the
// doc, so two callers of the same path share one signed URL). A `cacheEpoch`
// bump (clearSignedUrlCache, on sign-out) invalidates every in-flight resolve
// so a prior user's URL can't repopulate the cache for the next user on a
// shared device.
const cache    = new Map<string, SignedUrl>()
const inFlight = new Map<string, Promise<SignedUrl | null>>()
let cacheEpoch = 0

function isFresh(e: SignedUrl, now: number): boolean { return e.expiresAtMs - now > REFRESH_SKEW_MS }

/** Sync cache peek — used by the hook's initial state so a re-mount of an
 *  already-resolved attachment shows the URL without a null flash. Returns
 *  null unless a still-fresh entry is cached. */
export function peekSignedUrl(path: string): SignedUrl | null {
  const e = cache.get(path)
  return e && isFresh(e, Date.now()) ? e : null
}

/** Drop every cached signed URL + abandon in-flight resolves. Called by
 *  `clearAttachmentUrlCache()` on sign-out / account switch. Entity resolves
 *  self-settle null via the epoch guard, so there's nothing to drain. */
export function clearSignedUrlCache(): void {
  cacheEpoch += 1
  cache.clear()
  inFlight.clear()
}

// ─── Path parsing ──────────────────────────────────────────────────
// Every stored attachment path is `trips/{tripId}/{collection}/{entityId}/
// {file}`. The Worker re-derives the path from the doc; the coordinates we
// parse here are just the locator it needs (+ variant from the extension).

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

// ─── Entity full/pdf signer ────────────────────────────────────────

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
    const body = {
      tripId: ref.tripId,
      entityType: ref.entityType,
      entityId: ref.entityId,
      variant: ref.variant,
      ...(ref.entityType === 'booking' ? { path } : {}),
    }
    const res = await workerFetch(base, token, '/attachment-url', body) as { url?: string; expiresAt?: string }
    if (cacheEpoch !== startEpoch || !res.url || !res.expiresAt) return null
    const entry = toEntry(res.expiresAt, res.url)
    if (entry) cache.set(path, entry)
    return entry
  } catch {
    return null
  }
}

// ─── Public resolve ────────────────────────────────────────────────

/** Resolve a full/pdf attachment path to a signed URL (+ absolute expiry), or
 *  null on any failure. Serves a fresh cache hit synchronously-ish (resolved
 *  promise) and de-dups concurrent resolves of the same path. */
export function resolveSignedUrl(path: string): Promise<SignedUrl | null> {
  const cached = cache.get(path)
  if (cached && isFresh(cached, Date.now())) return Promise.resolve(cached)

  const existing = inFlight.get(path)
  if (existing) return existing

  const p = fetchEntityUrl(path)
    .finally(() => { if (inFlight.get(path) === p) inFlight.delete(path) })
  inFlight.set(path, p)
  return p
}
