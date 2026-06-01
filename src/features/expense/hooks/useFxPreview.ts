// src/features/expense/hooks/useFxPreview.ts
//
// Phase 3c-1 — client-side FX preview hook for the foreign-mode
// ExpenseFormModal. Fetches the Frankfurter v2 rate so the form can
// show the user "USD 12.34 → ¥1850 @ 146.2 (rate 2026-05-29)" before
// they hit save.
//
// Trust model:
//   This hook is PREVIEW ONLY. The Worker's expense-write router is
//   authoritative for the persisted fxSnapshot + amountMinor. If the
//   client-fetched rate disagrees with the Worker's authoritative
//   lookup (rare — same provider, same canonicalization), the Worker
//   wins. We never persist a client-fetched rate.
//
// Cache contract (TanStack Query):
//   - key:        ['fxPreview', requestedDate, sourceCurrency, tripCurrency]
//   - enabled:    sourceCurrency !== tripCurrency (skip degenerate path)
//   - staleTime:  Infinity — historical rates don't change once published;
//                 same-day pre-publish requests get yesterday's rate
//                 locked in (matches Worker fx-rate.ts cache semantics).
//   - retry:      1 — Frankfurter is generally fast and reliable; the
//                 form layer surfaces "換算レートを取得できません" on
//                 sustained failure rather than spinning on retries.
//   - gcTime:     30min (queryClient default) — preview is short-lived
//                 per form session; longer TTL just wastes memory.
//
// Why no Firestore cache:
//   The client preview is per-user, per-session. Worker-side caching
//   already deduplicates provider calls across users. A client cache
//   would either (a) require Firestore read rules on /fxRates (which
//   we don't grant — admin-only path) or (b) skip the deterministic
//   provider call, which is ~300ms anyway.
import { useQuery } from '@tanstack/react-query'
import { canonicalizeRate } from '@tripmate/fx-core'

/** Why the hook isn't running its query. Mutually exclusive with
 *  `isLoading` / `isError` / a resolved rate — when `disabledReason`
 *  is non-null the hook is by design not asking the provider, so the
 *  caller should render an explanation, not a "still loading" spinner.
 *
 *  Kept as a discriminated string union (not a boolean) so future
 *  reasons (e.g. offline / unsupported currency) slot in without
 *  breaking exhaustiveness in callers. */
export type FxPreviewDisabledReason =
  | 'future-date'
  | 'invalid-input'

/** Public hook output. `rateDecimal` + `rateDate` arrive together iff
 *  the provider responded successfully; partial state never surfaces.
 *  `isDegenerate` is true when source === trip (caller can short-circuit
 *  the preview UI without checking currencies again). `disabledReason`
 *  surfaces the specific reason the hook chose not to fetch — caller
 *  uses it to render a precise message instead of a generic "loading".  */
export interface FxPreviewResult {
  rateDecimal: string | null
  rateDate:    string | null
  isLoading:   boolean
  isError:     boolean
  isDegenerate: boolean
  disabledReason: FxPreviewDisabledReason | null
}

export interface UseFxPreviewInput {
  /** YYYY-MM-DD — the user's chosen expense date. Future dates short-
   *  circuit before fetch (Worker rejects FX_FUTURE_DATE_UNSUPPORTED;
   *  no point asking the provider). */
  requestedDate: string
  /** ISO 4217 uppercase. */
  sourceCurrency: string
  /** ISO 4217 uppercase — the trip's currency. */
  tripCurrency: string
}

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v2/rates'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CCY_RE = /^[A-Z]{3}$/

/** Today in UTC, YYYY-MM-DD. Matches Worker fx-rate.ts toUtcDateString
 *  semantics so client + Worker agree on the future-date boundary. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

interface FrankfurterRow {
  date:  string
  base:  string
  quote: string
  rate:  number
}

async function fetchFxRate(input: UseFxPreviewInput): Promise<{ rateDecimal: string; rateDate: string }> {
  const url = new URL(FRANKFURTER_BASE)
  url.searchParams.set('date',   input.requestedDate)
  url.searchParams.set('base',   input.sourceCurrency)
  url.searchParams.set('quotes', input.tripCurrency)

  const res = await fetch(url, {
    cache: 'no-store',
    // Preview is interactive — 8s upper bound mirrors Worker timeout so
    // a true outage surfaces at a consistent threshold across surfaces.
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) {
    throw new Error(`Frankfurter status ${res.status}`)
  }
  const data = (await res.json()) as unknown
  // v2 wraps single-quote requests in an array — exact same shape as
  // Worker fx-rate.ts. Defensive guards mirror the Worker boundary.
  if (!Array.isArray(data) || data.length !== 1) {
    throw new Error(`Frankfurter response shape mismatch`)
  }
  const row = data[0] as Partial<FrankfurterRow>
  if (
    typeof row.date !== 'string' || !ISO_DATE_RE.test(row.date) ||
    row.base  !== input.sourceCurrency ||
    row.quote !== input.tripCurrency   ||
    typeof row.rate !== 'number'
  ) {
    throw new Error(`Frankfurter row malformed`)
  }
  // canonicalizeRate rejects 0 / negative / NaN / Infinity — match the
  // Worker boundary so a malformed preview never lands a "0" in the
  // form's converted-amount display.
  const rateDecimal = canonicalizeRate(row.rate)
  return { rateDecimal, rateDate: row.date }
}

/** React hook for the foreign-mode FX preview. Returns null rate +
 *  isLoading until the provider resolves. Disabled (no fetch, no
 *  loading) when source === trip currency. `disabledReason` surfaces
 *  WHY we won't fetch when the inputs aren't usable — caller picks the
 *  user-facing message based on that (e.g. future date vs malformed
 *  currency code) instead of defaulting to a generic spinner. */
export function useFxPreview(input: UseFxPreviewInput): FxPreviewResult {
  const isDegenerate = input.sourceCurrency === input.tripCurrency
  // Input gating up front. Each branch is distinct because the user-
  // facing message differs:
  //   - shape invalid (regex fail) → "通貨または日付を確認してください"
  //   - future date                → "未来日付は換算できません"
  // Both prevent the fetch but the explanation in the form preview row
  // should be specific enough for the user to take action.
  const shapeValid =
    ISO_DATE_RE.test(input.requestedDate) &&
    CCY_RE.test(input.sourceCurrency)     &&
    CCY_RE.test(input.tripCurrency)
  const isFutureDate = shapeValid && input.requestedDate > todayUtc()

  let disabledReason: FxPreviewDisabledReason | null = null
  if (!isDegenerate) {
    if (!shapeValid)        disabledReason = 'invalid-input'
    else if (isFutureDate)  disabledReason = 'future-date'
  }

  const enabled = !isDegenerate && shapeValid && !isFutureDate

  const query = useQuery({
    queryKey: ['fxPreview', input.requestedDate, input.sourceCurrency, input.tripCurrency],
    queryFn:  () => fetchFxRate(input),
    enabled,
    // Historical rates immutable once published — see file header.
    staleTime: Infinity,
    retry:     1,
  })

  if (isDegenerate) {
    return {
      rateDecimal: null, rateDate: null,
      isLoading: false, isError: false,
      isDegenerate: true, disabledReason: null,
    }
  }
  return {
    rateDecimal:    query.data?.rateDecimal ?? null,
    rateDate:       query.data?.rateDate    ?? null,
    isLoading:      enabled && query.isLoading,
    isError:        query.isError,
    isDegenerate:   false,
    disabledReason,
  }
}
