// src/hooks/useAttachmentUrl.ts
//
// Path-only attachment reads. Firestore stores only the private R2 object
// path; bytes are fetched through the authenticated Worker proxy. The
// fetched Blob becomes an object URL that <img>/<a> can render.
//
// The public hook contract is intentionally unchanged from the former
// Firebase Storage implementation, so feature UIs remain storage-agnostic.
//
//   kind: 'thumb' -> list/grid thumbnails. SHARED objectURL in a module
//         LRU (many rows reference the same path across scroll / remount;
//         one fetch, one objectURL). Ref-counted: an entry is only revoked
//         on LRU eviction when no mounted component still holds it.
//   kind: 'full'  -> modal / full-size / PDF. PER-CALLER objectURL (NOT
//         shared): two callers opening the same path each createObjectURL
//         their own, so one closing/unmounting can't revoke the other's.
//
// Lifecycle mirrors useBlobUrl.ts: useEffect/useState side effects, NOT
// useMemo (createObjectURL is an effect, not a pure derivation). The
// thumb ref-count is taken in useLayoutEffect so an in-DOM thumbnail is
// marked active at commit time, before a concurrent mount's LRU eviction
// could revoke it.
//
// SECURITY: objectURLs point at private image bytes. Never persist them
// (React Query / Zustand / localStorage / Sentry context) -- they live
// only for the lifetime of the hook. `clearAttachmentUrlCache()` revokes
// everything on sign-out / account switch (see useAuth.ts).

import { useEffect, useLayoutEffect, useState } from 'react'
import { fetchAttachmentBlob } from '@/services/attachmentStorage'
import { captureError } from '@/services/sentry'

// ─── Shared blob-bytes fetch (in-flight dedup) ─────────────────────
// Keyed by path; the bytes are identical regardless of kind, so a thumb
// hook and a full hook for the same path share one Worker round-trip.
const blobInFlight = new Map<string, Promise<Blob | null>>()

// A missing object is not an error: fetchAttachmentBlob returns null on 404
// and only throws for auth / Worker / R2 failures. Those degrade to a
// placeholder in the UI, so without this report a broken Worker or a revoked
// permission would be invisible outside of user complaints.
//
// Deduped per failure mode because one outage fails every visible thumbnail
// at once — the useful signal is "expense thumbs are 403-ing", not 200 copies
// of it.
const reportedFailures = new Set<string>()

function reportAttachmentFailure(path: string, e: unknown): void {
  const err = e instanceof Error ? e : new Error(String(e))
  const status = (e as { status?: number } | null)?.status ?? null
  // Object paths are `trips/<id>/<entity>/<id>/<file>`; the ids identify a
  // trip and its members, so only the de-identified shape goes to Sentry.
  const [, , entity = 'unknown', , file = 'unknown'] = path.split('/')
  const signature = `${err.name}:${status}:${entity}`
  if (reportedFailures.has(signature)) return
  reportedFailures.add(signature)
  captureError(err, { source: 'useAttachmentUrl/fetch', status, entity, file })
}

async function fetchBlob(path: string): Promise<Blob | null> {
  const existing = blobInFlight.get(path)
  if (existing) return existing
  const p = (async () => {
    try {
      return await fetchAttachmentBlob(path)
    } catch (e) {
      reportAttachmentFailure(path, e)
      return null
    } finally {
      blobInFlight.delete(path)
    }
  })()
  blobInFlight.set(path, p)
  return p
}

// ─── Thumbnail cache: shared objectURL + ref-count + LRU ───────────
const THUMB_CACHE_MAX = 200
const thumbUrls    = new Map<string, string>()  // path -> objectURL
const thumbRefs    = new Map<string, number>()  // path -> active mount count
const thumbLastUsed = new Map<string, number>() // path -> LRU tick
let lruTick = 0

// Cache generation. clearAttachmentUrlCache() (sign-out / account switch)
// bumps it; in-flight fetches capture the epoch at start and drop their
// result if it changed, so a request begun for the previous user can't
// repopulate the cache with their private bytes after the clear.
let cacheEpoch = 0

// Live per-caller `full` objectURLs (modal / full-size previews). Unlike
// thumbnails these are NOT shared via the LRU, so they'd survive a cache
// clear unless tracked globally: registered on create, removed on the
// owning hook's revoke, and force-revoked by clearAttachmentUrlCache so a
// signed-out user's full-size private blob can't linger in memory.
const fullUrls = new Set<string>()

function touchThumb(path: string): void {
  thumbLastUsed.set(path, ++lruTick)
}
function acquireThumb(path: string): void {
  thumbRefs.set(path, (thumbRefs.get(path) ?? 0) + 1)
  touchThumb(path)
}
function releaseThumb(path: string): void {
  const n = (thumbRefs.get(path) ?? 1) - 1
  if (n <= 0) thumbRefs.delete(path)
  else thumbRefs.set(path, n)
}

/** Evict least-recently-used thumbnails over the cap, but ONLY entries no
 *  mounted component still holds (refCount 0). If every cached entry is
 *  active we temporarily exceed the cap rather than revoke an in-use URL
 *  (which would break a visible <img>). */
function evictThumbsIfNeeded(): void {
  while (thumbUrls.size > THUMB_CACHE_MAX) {
    let victim: string | undefined
    let oldest = Infinity
    for (const [path, url] of thumbUrls) {
      void url
      if ((thumbRefs.get(path) ?? 0) > 0) continue       // in use -- never evict
      const used = thumbLastUsed.get(path) ?? 0
      if (used < oldest) { oldest = used; victim = path }
    }
    if (victim === undefined) break                       // all active -- exceed cap
    const url = thumbUrls.get(victim)
    if (url) URL.revokeObjectURL(url)
    thumbUrls.delete(victim)
    thumbLastUsed.delete(victim)
  }
}

type AttachmentUrlState = {
  path:  string | null
  kind:  'thumb' | 'full'
  url:   string | null
  epoch: number
}

/**
 * Resolve a private attachment object path to a renderable objectURL, or `null`
 * while loading / on failure (callers treat null as "show placeholder",
 * exactly as they treated an absent thumbUrl before).
 *
 * `kind: 'thumb'` for list thumbnails (cached, shared, ref-counted);
 * `kind: 'full'` for modal / full-size / PDF (per-caller, revoked on
 * unmount). Pass the SMALLER `thumbPath` for thumbnails and the full
 * `path` for full-size views.
 */
export function useAttachmentUrl(
  path: string | null | undefined,
  opts: { kind: 'thumb' | 'full' },
): string | null {
  const { kind } = opts
  const key = path ?? null

  // The resolved URL is TAGGED with the (path, kind) it was produced for.
  // The render return compares the tag against the CURRENT input, so a
  // path/kind change hides the previous (possibly already-revoked) URL in
  // the SAME render — not a frame later via the effect. The value is React
  // state (not a module-cache read in render) so React Compiler stays
  // correct. Initializer seeds a synchronous thumb-cache hit (no flash when
  // a cached list re-mounts).
  const [state, setState] = useState<AttachmentUrlState>(
    () => {
      // Seed a synchronous cache hit so a re-mount of an already-resolved
      // thumbnail shows the URL without a null flash.
      let seed: string | null = null
      if (key) {
        seed = kind === 'thumb' ? thumbUrls.get(key) ?? null : null
      }
      return { path: key, kind, url: seed, epoch: cacheEpoch }
    },
  )

  // Thumb ref-count: taken at DOM commit (useLayoutEffect), released on
  // unmount / path change. Keeps a visible thumbnail from being evicted.
  // The LRU/ref-count guards object URLs created for thumbnail blobs.
  useLayoutEffect(() => {
    if (kind !== 'thumb' || !key) return
    acquireThumb(key)
    return () => releaseThumb(key)
  }, [kind, key])

  useEffect(() => {
    if (!key) return   // nothing to fetch; render guard already shows null
    // Generation guard (see cacheEpoch): drop any result whose cache was
    // cleared mid-flight so a prior user's bytes never repopulate the cache.
    const epoch = cacheEpoch
    let cancelled = false
    const settle = (url: string | null) => {
      if (cancelled || epoch !== cacheEpoch) return   // unmounted or cache cleared
      setState({ path: key, kind, url, epoch })
    }

    if (kind === 'thumb') {
      const cached = thumbUrls.get(key)
      if (cached) { touchThumb(key); settle(cached); return }
      void fetchBlob(key).then(blob => {
        if (cancelled || epoch !== cacheEpoch || !blob) return
        let u = thumbUrls.get(key)             // another caller may have won the race
        if (!u) {
          u = URL.createObjectURL(blob)
          thumbUrls.set(key, u)
          touchThumb(key)
          evictThumbsIfNeeded()
        }
        settle(u)
      })
      return () => { cancelled = true }
    }

    // full: own objectURL, revoked on unmount / path change so two callers
    // of the same path never share (and revoke) one URL. Registered in
    // `fullUrls` so clearAttachmentUrlCache (sign-out) can revoke it even
    // while this modal is still mounted.
    let own: string | null = null
    void fetchBlob(key).then(blob => {
      if (cancelled || epoch !== cacheEpoch || !blob) return
      own = URL.createObjectURL(blob)
      fullUrls.add(own)
      settle(own)
    })
    return () => {
      cancelled = true
      if (own) { URL.revokeObjectURL(own); fullUrls.delete(own) }
    }
  }, [kind, key])

  // Render guard: surface the URL only when it belongs to the CURRENT input
  // AND its cache generation is still live (a sign-out / account switch bumps
  // cacheEpoch → returns null on the next render, even before unmount).
  if (state.path !== key || state.kind !== kind || state.epoch !== cacheEpoch) {
    return null
  }

  // Full object URLs are per-caller and revoked on close. The React state can
  // still remember that old (path, url) pair; reopening the same path must not
  // surface a revoked blob: URL for one render before the next fetch settles.
  if (kind === 'full' && state.url && !fullUrls.has(state.url)) {
    return null
  }

  return state.url
}

/** Revoke + drop every cached attachment objectURL. Call on sign-out /
 *  account switch so one user's private image bytes can't linger in the
 *  module cache for the next user on a shared device. */
export function clearAttachmentUrlCache(): void {
  cacheEpoch += 1                         // invalidate in-flight fetches + force render guard to null
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url)
  for (const url of fullUrls)            URL.revokeObjectURL(url)   // open modals' full blobs
  thumbUrls.clear()
  thumbRefs.clear()
  thumbLastUsed.clear()
  fullUrls.clear()
  blobInFlight.clear()
}
