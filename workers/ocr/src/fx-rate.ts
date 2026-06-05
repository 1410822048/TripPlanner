// workers/ocr/src/fx-rate.ts
//
// Phase 2 of the FX multicurrency design (see memory:
// fx-multicurrency-design). Worker-authoritative FX rate lookup +
// snapshot construction, shared by the expense-write AND
// settlement-write paths (a snapshot records one source→target
// conversion event; how the consumer uses it differs — see FxSnapshot).
//
// Why this lives in the Worker and not the client:
//   The expense's stored `amountMinor` is the target-currency
//   conversion of the user-typed `sourceAmountMinor`. If the client
//   computed the conversion, a malicious editor could write a
//   favorable rate ($1 = ¥10000) and corrupt every settlement. Worker
//   is the only trust boundary that can pin the rate to a verifiable
//   provider response, persist the rate snapshot atomically with the
//   expense doc, and reject future-date requests.
//
// Cache contract (Firestore `fxRates/{date}_{base}_{quote}`):
//   - Key is REQUESTED date, not the rateDate the provider returned --
//     replay with the same input must hit the same doc. Provider may
//     return an earlier rateDate (weekend / pre-publish window); we
//     accept it and lock it in.
//   - Doc is admin-only (firestore.rules Phase 5 will pin
//     `allow read, write: if false` on /fxRates/{id}); for Phase 2 we
//     rely on no client SDK touching the path, deferred lockdown is
//     tracked in the design doc.
//   - rateDecimal is a canonical positive decimal string per
//     `@tripmate/fx-core` (see canonicalizeRate); cache hits feed the
//     same string straight into convertMinorHalfEven, so the math is
//     byte-stable across replay.
//   - No TTL. Frankfurter's historical rates don't change once
//     published; once cached, that's the authoritative record. Same-day
//     pre-publish requests get yesterday's rate locked in -- intentional
//     per design decision #3 (no second look once cached).
//
// Provider:
//   Frankfurter v2 — `GET https://api.frankfurter.dev/v2/rates?
//                          date=YYYY-MM-DD&base=USD&quotes=JPY`
//   Response: ARRAY of one record per quote currency, e.g.
//     `[{ date: 'YYYY-MM-DD', base: 'USD', quote: 'JPY', rate: 159.35 }]`
//   Even single-quote requests come back wrapped in an array. We always
//   request exactly one quote and require `rows.length === 1`. Decoded
//   number flows through `canonicalizeRate` before storage so we never
//   persist a JS float.
//
// Failure modes intentionally surfaced (not silently swallowed):
//   - source date in the future       → FxError 'FX_FUTURE_DATE_UNSUPPORTED'
//   - currency code malformed         → FxError 'FX_INVALID_CURRENCY'
//   - cache miss + provider non-200   → FxError 'FX_PROVIDER_REJECTED'
//   - cache miss + provider unreachable → FxError 'FX_PROVIDER_UNAVAILABLE'
//   - provider returns zero / non-finite rate → FxError 'FX_PROVIDER_REJECTED'
//
// What's deliberately NOT here:
//   - Currency-list validation -- Frankfurter knows its own supported
//     codes; we forward any uppercase-3-letter input and let the
//     provider 404 if unknown.
//   - Rate-decimal canonicalization across providers -- single provider
//     for now; if a fallback provider is added we'd canonicalize at
//     each provider boundary, but cache key stays provider-agnostic.
import { canonicalizeRate, convertMinorHalfEven } from '@tripmate/fx-core'
import { getAdminToken, getProjectId }            from './admin'
import type { FsValue } from './firestore'

// ─── Types ────────────────────────────────────────────────────────

/** Stable error code surfaced to expense-write so the user-visible
 *  message can vary by reason (future date vs. provider down vs.
 *  currency typo). `status` maps directly onto the HTTP response from
 *  the eventual /expense-create handler. */
export type FxErrorCode =
  | 'FX_FUTURE_DATE_UNSUPPORTED'
  | 'FX_INVALID_CURRENCY'
  | 'FX_INVALID_DATE'
  | 'FX_PROVIDER_REJECTED'
  | 'FX_PROVIDER_UNAVAILABLE'

export class FxError extends Error {
  readonly code:   FxErrorCode
  readonly status: number
  constructor(code: FxErrorCode, status: number, message: string) {
    super(message)
    this.code   = code
    this.status = status
    this.name   = 'FxError'
  }
}

/** Snapshot persisted alongside a money amount (expense or settlement).
 *  Both the rate decimal AND the rateDate are stored so the client can
 *  display "USD 12.34 → JPY 1804 @ 146.2 (rate 2026-05-29)" without
 *  re-resolving the cache.
 *
 *  `convertedAmountMinor` is the FX forward result: `source → target`
 *  via half-even rounding. Its relationship to the consumer's ledger
 *  amount depends on the path:
 *    - expense-write: convertedAmountMinor IS the materialized
 *      `expense.amountMinor` (they're equal after the tx commits).
 *    - settlement-write: DECOUPLED. The ledger `amountMinor` is the
 *      pair-remaining (full clear of the suggested debt); the source
 *      is inverse-derived at-most-remaining, so the forward
 *      convertedAmountMinor may be ≤ amountMinor by a few minor units
 *      (half-even plateau) — intentional, NOT a drift bug.
 *  Either way it's a self-contained record of one conversion event:
 *  a future auditor can recompute it without recovering fraction-digit
 *  counts from the currency code. */
export interface FxSnapshot {
  provider:             'frankfurter-v2'
  baseCurrency:         string
  quoteCurrency:        string
  requestedDate:        string  // YYYY-MM-DD
  rateDate:             string  // YYYY-MM-DD (may differ — weekend / pre-publish)
  rateDecimal:          string  // canonical decimal per fx-core
  sourceAmountMinor:    number
  convertedAmountMinor: number
  /** Epoch ms; expense-write turns into Firestore Timestamp at commit. */
  fetchedAtMs:          number
}

export interface GetFxSnapshotInput {
  requestedDate:         string  // YYYY-MM-DD
  sourceCurrency:        string  // ISO 4217 uppercase
  tripCurrency:          string  // ISO 4217 uppercase
  sourceAmountMinor:     number  // signed integer minor units
  sourceFractionDigits:  number
  targetFractionDigits:  number
}

/** Just the rate, without the snapshot wrapper. Used by callers that
 *  need to inverse-derive a source amount BEFORE they can build the full
 *  snapshot — settlement-write does this: it computes pair-remaining in
 *  trip-currency, then asks for the rate, then inverse-derives the
 *  source amount that doesn't overshoot remaining. The full
 *  `getFxSnapshot` is then a thin convert+package over this helper. */
export interface ResolveFxRateInput {
  requestedDate:  string
  sourceCurrency: string
  tripCurrency:   string
}
export interface ResolvedFxRate {
  /** May differ from requestedDate (weekend / pre-publish). */
  rateDate:    string
  /** Canonical decimal per fx-core. */
  rateDecimal: string
  /** Epoch ms the rate was resolved (cache hit or provider). Lets the
   *  caller compose `fxSnapshot.fetchedAtMs` without a second `now`. */
  fetchedAtMs: number
}

/** Test seams. `now` lets tests fix "today" for future-date checks;
 *  `fetchImpl` overrides the global fetch for both Frankfurter AND
 *  Firestore REST calls. Production callers omit. */
export interface GetFxSnapshotOptions {
  now?:        Date
  fetchImpl?:  typeof fetch
}

// ─── Constants ────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CCY_RE      = /^[A-Z]{3}$/

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v2/rates'

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1'

/** Provider request timeout. Frankfurter is generally <300ms; 8s
 *  leaves headroom for global outliers without blocking the
 *  expense-write tx for too long on a true outage. */
const PROVIDER_TIMEOUT_MS = 8_000

// ─── Public helpers ───────────────────────────────────────────────

/** Compose the cache doc key as `{date}_{base}_{quote}`. Exported for
 *  Phase 5 cron / inspector tooling; internal callers use this too. */
export function fxCacheKey(date: string, base: string, quote: string): string {
  return `${date}_${base}_${quote}`
}

/** Compute the UTC date string (YYYY-MM-DD) for a given moment. Used
 *  for the future-date guard. UTC is chosen because Frankfurter
 *  publishes against ECB business days and our cache key + provider
 *  query also speak YYYY-MM-DD without a timezone, so an internally
 *  consistent UTC bound is the simplest contract. */
export function toUtcDateString(at: Date): string {
  return at.toISOString().slice(0, 10)
}

// ─── Cache I/O ────────────────────────────────────────────────────

interface CacheRecord {
  rateDecimal:   string
  rateDate:      string
  /** When this cache doc was originally written (epoch ms). Returned
   *  for diagnostics; the per-expense fxSnapshot.fetchedAtMs is the
   *  expense-creation time, NOT this value. */
  cachedAtMs:    number
}

/** Read a cache doc. Returns null on 404 OR on malformed doc (defensive
 *  against partial writes / manual edits) -- caller falls through to
 *  provider fetch.
 *
 *  We bypass `firestore.ts:getDocFields` and call the REST endpoint
 *  inline so the `fetchImpl` test seam covers both cache reads AND
 *  cache writes uniformly. The shared helper hard-binds to the global
 *  `fetch`, which would force tests to override `globalThis.fetch` for
 *  the read leg while still being able to use `fetchImpl` for the
 *  Frankfurter leg — error-prone and asymmetric with `writeCache`
 *  below. */
async function readCache(
  accessToken: string,
  projectId:   string,
  cacheKey:    string,
  fetchImpl:   typeof fetch,
): Promise<CacheRecord | null> {
  const path    = `fxRates/${cacheKey}`
  const docName = `projects/${projectId}/databases/(default)/documents/${path}`
  const res = await fetchImpl(`${FIRESTORE_BASE}/${docName}`, {
    cache:   'no-store',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`readCache ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as { fields?: Record<string, FsValue> }
  const fields = data.fields
  if (!fields) return null
  const rateDecimal = fields.rateDecimal?.stringValue
  const rateDate    = fields.rateDate?.stringValue
  if (!rateDecimal || !rateDate)        return null
  if (!ISO_DATE_RE.test(rateDate))      return null
  // canonical guarantee from the writer; defensive re-validate here
  // would just re-import isCanonicalRateString -- skip, expense-write
  // will fail-fast on the math step if anything ever corrupts the
  // cached string.
  const cachedAtIso = fields.cachedAt?.timestampValue
  const cachedAtMs  = typeof cachedAtIso === 'string' ? Date.parse(cachedAtIso) : Date.now()
  return { rateDecimal, rateDate, cachedAtMs: Number.isFinite(cachedAtMs) ? cachedAtMs : Date.now() }
}

/** Upsert a cache doc. PATCH without `currentDocument.exists` so a
 *  concurrent miss → fetch → write race resolves harmlessly (both
 *  writes land the same canonical rate from the same provider
 *  response; last-write-wins is fine because the value is identical).
 *
 *  Why upsert vs create-only: a 409 on create-only would force a
 *  re-read just to use the same value the racing call already wrote.
 *  Upsert avoids the round-trip; idempotency comes from the canonical
 *  rate, not the doc existence check. */
async function writeCache(
  accessToken: string,
  projectId:   string,
  cacheKey:    string,
  record: {
    base:            string
    quote:           string
    requestedDate:   string
    rateDate:        string
    rateDecimal:     string
    nowMs:           number
  },
  fetchImpl: typeof fetch,
): Promise<void> {
  const path    = `fxRates/${cacheKey}`
  const docName = `projects/${projectId}/databases/(default)/documents/${path}`
  const url     = new URL(`${FIRESTORE_BASE}/${docName}`)
  // Listing each field in the mask makes this a scoped upsert: if a
  // doc already exists with extra fields (e.g. a future Phase 5 admin
  // annotation), those survive the write.
  for (const fp of ['provider', 'baseCurrency', 'quoteCurrency', 'requestedDate', 'rateDate', 'rateDecimal', 'cachedAt']) {
    url.searchParams.append('updateMask.fieldPaths', fp)
  }
  const fields: Record<string, FsValue> = {
    provider:      { stringValue: 'frankfurter-v2' },
    baseCurrency:  { stringValue: record.base },
    quoteCurrency: { stringValue: record.quote },
    requestedDate: { stringValue: record.requestedDate },
    rateDate:      { stringValue: record.rateDate },
    rateDecimal:   { stringValue: record.rateDecimal },
    cachedAt:      { timestampValue: new Date(record.nowMs).toISOString() },
  }
  const res = await fetchImpl(url, {
    method:  'PATCH',
    cache:   'no-store',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`writeCache ${path} → ${res.status}: ${detail.slice(0, 200)}`)
  }
}

// ─── Provider call ────────────────────────────────────────────────

interface ProviderRate {
  rateDate:    string
  rateDecimal: string
}

/** Fetch a single rate from Frankfurter v2 and canonicalize it.
 *
 *  Response shape: an ARRAY with one record per requested quote. We
 *  always pass exactly one quote, so we require length === 1.
 *    [{ date: 'YYYY-MM-DD', base: 'USD', quote: 'JPY', rate: 146.2 }]
 *
 *  Tolerated drift:
 *    - row.date may legitimately be earlier than the requested date
 *      (weekend / holiday / pre-publish window). We accept and
 *      surface it as rateDate so the snapshot is auditable.
 *    - row.base / row.quote MUST match what we asked for; mismatch is
 *      provider-side error → FX_PROVIDER_REJECTED.
 *    - non-array body or rows.length !== 1 → FX_PROVIDER_REJECTED.
 *      Shape regression would silently surface as bogus `rateDate=''`
 *      reject — fail fast at the boundary instead. */
async function fetchProviderRate(
  requestedDate: string,
  base:          string,
  quote:         string,
  fetchImpl:     typeof fetch,
): Promise<ProviderRate> {
  const url = new URL(FRANKFURTER_BASE)
  url.searchParams.set('date',   requestedDate)
  url.searchParams.set('base',   base)
  url.searchParams.set('quotes', quote)

  let res: Response
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    })
  } catch (e) {
    throw new FxError(
      'FX_PROVIDER_UNAVAILABLE', 502,
      `Frankfurter fetch failed: ${(e as Error).message}`,
    )
  }
  if (!res.ok) {
    // 400/404/422 → bad input (likely an unsupported currency). Surface
    // as REJECTED with a 400 so the user-visible message guides them
    // to fix the currency. 5xx upstream → UNAVAILABLE / 502.
    const detail = await res.text().catch(() => '')
    if (res.status >= 500) {
      throw new FxError(
        'FX_PROVIDER_UNAVAILABLE', 502,
        `Frankfurter status ${res.status}: ${detail.slice(0, 200)}`,
      )
    }
    throw new FxError(
      'FX_PROVIDER_REJECTED', 400,
      `Frankfurter status ${res.status}: ${detail.slice(0, 200)}`,
    )
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new FxError(
      'FX_PROVIDER_REJECTED', 502,
      'Frankfurter returned non-JSON',
    )
  }
  // v2 wraps even single-quote responses in an array. Defend against
  // both "wrong top-level type" (object instead of array) and
  // "right type, wrong cardinality" (zero or 2+ rows).
  if (!Array.isArray(data)) {
    throw new FxError(
      'FX_PROVIDER_REJECTED', 502,
      `Frankfurter response not an array: ${typeof data}`,
    )
  }
  if (data.length !== 1) {
    throw new FxError(
      'FX_PROVIDER_REJECTED', 502,
      `Frankfurter response expected 1 row, got ${data.length}`,
    )
  }
  const row = data[0] as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown }
  const rateDate = typeof row.date  === 'string' ? row.date  : ''
  const respBase = typeof row.base  === 'string' ? row.base  : ''
  const respQuote= typeof row.quote === 'string' ? row.quote : ''
  const rateNum  = typeof row.rate  === 'number' ? row.rate  : NaN
  if (!ISO_DATE_RE.test(rateDate)) {
    throw new FxError('FX_PROVIDER_REJECTED', 502, `Frankfurter missing/invalid date: ${rateDate}`)
  }
  if (respBase !== base || respQuote !== quote) {
    throw new FxError(
      'FX_PROVIDER_REJECTED', 502,
      `Frankfurter pair mismatch: requested ${base}->${quote} got ${respBase}->${respQuote}`,
    )
  }
  // Provider should never quote a future date for a past request; if
  // it ever does (clock skew / publication anomaly), treat as rejected
  // rather than silently storing future rateDate.
  if (rateDate > requestedDate) {
    throw new FxError(
      'FX_PROVIDER_REJECTED', 502,
      `Frankfurter rateDate ${rateDate} ahead of requested ${requestedDate}`,
    )
  }
  let rateDecimal: string
  try {
    rateDecimal = canonicalizeRate(rateNum)
  } catch (e) {
    // canonicalizeRate already rejects 0, negative, NaN, ±Infinity.
    // Wrap as REJECTED so the caller surfaces a usable error.
    throw new FxError(
      'FX_PROVIDER_REJECTED', 502,
      `Frankfurter rate not canonical: ${(e as Error).message}`,
    )
  }
  return { rateDate, rateDecimal }
}

// ─── Public entry point ───────────────────────────────────────────

/** Resolve the FX snapshot for an expense. Returns `null` when source
 *  currency equals trip currency (degenerate path: expense-write skips
 *  the conversion entirely and persists `sourceAmountMinor` as the
 *  authoritative amountMinor).
 *
 *  Steps:
 *    1. Defensive validation (date format, currency codes, integer
 *       source amount, fraction-digit sanity).
 *    2. Future-date guard against `options.now` (UTC date string).
 *    3. Cache lookup at `fxRates/{date}_{base}_{quote}`.
 *    4. On miss: provider fetch + canonicalize + cache write (best
 *       effort; cache write failure is logged but doesn't fail the
 *       request -- the rate is still usable for this expense).
 *    5. Convert sourceAmountMinor → convertedAmountMinor via fx-core.
 *    6. Build + return FxSnapshot.
 *
 *  Concurrency: two requests for the same (date, base, quote) racing
 *  on cache miss both call Frankfurter and both write the cache. Last
 *  write wins; since Frankfurter is deterministic for past dates the
 *  canonical rate is byte-identical, so the race is benign. */
export async function getFxSnapshot(
  input:              GetFxSnapshotInput,
  serviceAccountJson: string,
  options:            GetFxSnapshotOptions = {},
): Promise<FxSnapshot | null> {
  // sourceAmountMinor sanity stays here (resolveFxRate doesn't see it).
  if (!Number.isInteger(input.sourceAmountMinor)) {
    throw new FxError('FX_INVALID_CURRENCY', 400, `sourceAmountMinor must be integer, got ${input.sourceAmountMinor}`)
  }
  if (!Number.isInteger(input.sourceFractionDigits) || input.sourceFractionDigits < 0 || input.sourceFractionDigits > 6) {
    throw new FxError('FX_INVALID_CURRENCY', 400, `sourceFractionDigits out of range`)
  }
  if (!Number.isInteger(input.targetFractionDigits) || input.targetFractionDigits < 0 || input.targetFractionDigits > 6) {
    throw new FxError('FX_INVALID_CURRENCY', 400, `targetFractionDigits out of range`)
  }

  const resolved = await resolveFxRate(
    {
      requestedDate:  input.requestedDate,
      sourceCurrency: input.sourceCurrency,
      tripCurrency:   input.tripCurrency,
    },
    serviceAccountJson,
    options,
  )
  if (!resolved) return null

  const convertedAmountMinor = convertMinorHalfEven({
    sourceMinor:          input.sourceAmountMinor,
    rateDecimal:          resolved.rateDecimal,
    sourceFractionDigits: input.sourceFractionDigits,
    targetFractionDigits: input.targetFractionDigits,
  })

  return {
    provider:             'frankfurter-v2',
    baseCurrency:         input.sourceCurrency,
    quoteCurrency:        input.tripCurrency,
    requestedDate:        input.requestedDate,
    rateDate:             resolved.rateDate,
    rateDecimal:          resolved.rateDecimal,
    sourceAmountMinor:    input.sourceAmountMinor,
    convertedAmountMinor,
    fetchedAtMs:          resolved.fetchedAtMs,
  }
}

/** Resolve just the canonical rate + rateDate for a (requestedDate,
 *  base, quote) tuple. Cache-aware (same key + write-through path as
 *  `getFxSnapshot`). Returns `null` when source === trip (degenerate
 *  path: caller skips conversion). Validates the rate-only subset of
 *  the input; sourceAmountMinor / fraction digits live on
 *  `getFxSnapshot` since rate resolution doesn't depend on them. */
export async function resolveFxRate(
  input:              ResolveFxRateInput,
  serviceAccountJson: string,
  options:            GetFxSnapshotOptions = {},
): Promise<ResolvedFxRate | null> {
  const now       = options.now       ?? new Date()
  const fetchImpl = options.fetchImpl ?? fetch

  if (!ISO_DATE_RE.test(input.requestedDate)) {
    throw new FxError('FX_INVALID_DATE', 400, `requestedDate must be YYYY-MM-DD, got ${input.requestedDate}`)
  }
  if (!CCY_RE.test(input.sourceCurrency)) {
    throw new FxError('FX_INVALID_CURRENCY', 400, `sourceCurrency must be ISO 4217 (3 uppercase letters), got ${input.sourceCurrency}`)
  }
  if (!CCY_RE.test(input.tripCurrency)) {
    throw new FxError('FX_INVALID_CURRENCY', 400, `tripCurrency must be ISO 4217 (3 uppercase letters), got ${input.tripCurrency}`)
  }

  if (input.sourceCurrency === input.tripCurrency) return null

  const todayUtc = toUtcDateString(now)
  if (input.requestedDate > todayUtc) {
    throw new FxError(
      'FX_FUTURE_DATE_UNSUPPORTED', 400,
      `requestedDate ${input.requestedDate} is in the future (today UTC ${todayUtc})`,
    )
  }

  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)

  const cacheKey = fxCacheKey(input.requestedDate, input.sourceCurrency, input.tripCurrency)

  const cached = await readCache(accessToken, projectId, cacheKey, fetchImpl)
  if (cached) {
    return {
      rateDate:    cached.rateDate,
      rateDecimal: cached.rateDecimal,
      fetchedAtMs: now.getTime(),
    }
  }
  const provider = await fetchProviderRate(
    input.requestedDate,
    input.sourceCurrency,
    input.tripCurrency,
    fetchImpl,
  )
  try {
    await writeCache(accessToken, projectId, cacheKey, {
      base:          input.sourceCurrency,
      quote:         input.tripCurrency,
      requestedDate: input.requestedDate,
      rateDate:      provider.rateDate,
      rateDecimal:   provider.rateDecimal,
      nowMs:         now.getTime(),
    }, fetchImpl)
  } catch (e) {
    console.warn(`[fx] cache write failed for ${cacheKey}: ${(e as Error).message}`)
  }
  return {
    rateDate:    provider.rateDate,
    rateDecimal: provider.rateDecimal,
    fetchedAtMs: now.getTime(),
  }
}
