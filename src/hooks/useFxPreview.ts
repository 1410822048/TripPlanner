// src/hooks/useFxPreview.ts
//
// Client-side FX preview hook. Fetches the Frankfurter v2 rate so a
// form can show the user "USD 12.34 → ¥1850 @ 146.2 (rate 2026-05-29)"
// before they hit save. Originally introduced as Phase 3c-1 for the
// foreign-mode ExpenseFormModal; promoted from features/expense/hooks/
// to src/hooks/ during the Settlement FX rollout (Commit 3/4) so the
// settlement record sheet can reuse it. API unchanged.
//
// Rate source:
//   Cloud trips preview with the Worker's /fx-rate, which answers from the
//   same cache-first resolveFxRate the expense / settlement writes use (and
//   pins the rate on a miss). The preview therefore shows the rate the save
//   will convert with — previously the browser asked Frankfurter directly,
//   and when the Worker's cached rate for that date was an earlier answer
//   (e.g. fetched before the ECB published) the saved amount silently
//   differed from the one on screen. Editing a foreign expense with the same
//   date and currencies shows the stored rate (`pinned`), which the Worker
//   reuses. Demo / unconfigured builds keep the direct Frankfurter preview;
//   nothing is saved there.
//
// Cache contract (TanStack Query):
//   - key:        ['fxPreview', tripId | 'direct', requestedDate, source, trip]
//   - enabled:    sourceCurrency !== tripCurrency, valid, not future, not pinned
//   - staleTime:  Infinity for a final answer (fx-core isFinalRate, the
//                 same rule the Worker caches by); 0 for a provisional one
//                 (today, not yet published), so a reopened form re-asks
//   - refetchInterval: 5min while provisional, so an open form follows
//                 publication; a save that still lands between refetches
//                 uses the Worker's rate (by design, no drift reject)
//   - retry:      1
//   - gcTime:     30min (queryClient default)
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { requireWorkerWriteBase, workerRead } from '@/services/workerBase'
import { canonicalizeRate, isFinalRate } from '@tripmate/fx-core'
import { toLocalDateString } from '@/utils/dates'

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
  /** rateDecimal + rateDate together, or null — what a save sends as its
   *  `expectedFxRate` (the rate the user is looking at). */
  rateQuote:   FxRateQuote | null
  /** The shown rate can no longer change (fx-core isFinalRate), or is the
   *  stored rate the Worker reuses. A save may then close optimistically;
   *  a provisional rate keeps the form open so a FX_RATE_CHANGED refusal
   *  can be confirmed in place. Not a correctness claim — the Worker CAS
   *  runs either way. */
  isFinal:     boolean
  isLoading:   boolean
  isError:     boolean
  isDegenerate: boolean
  disabledReason: FxPreviewDisabledReason | null
  /** Show the rate a 409 FX_RATE_CHANGED carried. That rate IS the
   *  Worker's answer for this request, so it is shown as-is — asking
   *  /fx-rate again could already return something newer and reopen the
   *  window the CAS just closed. Superseded only by a later preview fetch. */
  adoptRate:   (quote: FxRateQuote) => void
}

/** A rate as shown to the user / as the Worker answered it. */
export interface FxRateQuote {
  rateDecimal: string
  rateDate:    string
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
  /** Cloud trip id. When set, the rate comes from the Worker's /fx-rate —
   *  the same cached rate the save will convert with — instead of straight
   *  from Frankfurter, so the previewed amount is the saved amount. Demo /
   *  signed-out forms (no trip) keep the direct Frankfurter preview. */
  tripId?: string | null
  /** A rate already stored on the expense being edited, valid for exactly
   *  this (date, source, trip) — the Worker reuses it on update, so the
   *  preview must show it rather than ask again. */
  pinned?: { rateDecimal: string; rateDate: string } | null
}

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v2/rates'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CCY_RE = /^[A-Z]{3}$/

/** Today in UTC, YYYY-MM-DD. Only ever compared against the PROVIDER's
 *  published `rateDate` — a rate dated after the current UTC day would be
 *  a rate that cannot exist yet. Never compared against what the user
 *  typed; see the local-today gate below. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** How often an open form re-asks while the rate is still provisional. */
const PROVISIONAL_REFETCH_MS = 5 * 60_000

/** Same finality rule as the Worker's fxRates cache (fx-core isFinalRate). */
function isFinalAnswer(data: { rateDate: string } | undefined, requestedDate: string): boolean {
  return !!data && isFinalRate({ rateDate: data.rateDate, requestedDate, todayUtc: todayUtc() })
}

/** Today where the USER is. The date they pick is a calendar date in
 *  their own timezone, so this is what bounds it.
 *
 *  These were the same function until it turned out they are not the same
 *  question. The expense form already defaults its date to local today
 *  (ExpensePage), while this hook rejected anything past UTC today — so
 *  everywhere east of UTC, every morning, the form pre-filled a date and
 *  then refused to convert it as "a future date". In Japan that is
 *  00:00–09:00 daily, and it blocked saving, not just the preview. */
function todayLocal(): string {
  return toLocalDateString(new Date())
}

interface FrankfurterRow {
  date:  string
  base:  string
  quote: string
  rate:  number
}

/** Preview from the Worker's write-path rate (see `tripId` above). */
async function fetchWorkerFxRate(
  input:  UseFxPreviewInput & { tripId: string },
  base:   string,
): Promise<{ rateDecimal: string; rateDate: string }> {
  const body = await workerRead<unknown>('/fx-rate', {
    tripId:         input.tripId,
    requestedDate:  input.requestedDate,
    sourceCurrency: input.sourceCurrency,
  }, {
    base,
    timeoutMs: 15_000,
    toError:   failure => new Error(`fx-rate preview failed: ${failure.kind === 'status' ? failure.status : failure.kind}`),
  })
  const parsed = WorkerFxRateSchema.safeParse(body)
  // A trip whose currency differs from what the form believes (another
  // member changed it before the first expense) must not preview at all.
  if (!parsed.success || parsed.data.degenerate || parsed.data.tripCurrency !== input.tripCurrency) {
    throw new Error('fx-rate preview response does not match the request')
  }
  return { rateDecimal: parsed.data.rateDecimal, rateDate: parsed.data.rateDate }
}

const WorkerFxRateSchema = z.discriminatedUnion('degenerate', [
  z.object({ degenerate: z.literal(true), tripCurrency: z.string() }),
  z.object({
    degenerate:   z.literal(false),
    tripCurrency: z.string(),
    rateDecimal:  z.string().min(1),
    rateDate:     z.string().regex(ISO_DATE_RE),
  }),
])

/** The privileged Worker base, or null when this build has none configured
 *  (local / preview without VITE_WORKER_BASE_URL) — then the direct
 *  Frankfurter preview is the only option. */
function workerBaseOrNull(): string | null {
  try { return requireWorkerWriteBase() } catch { return null }
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
  // The requested date may now sit a day ahead of UTC (a user east of
  // Greenwich asking for their own today), so the response bound is its
  // own check rather than a consequence of the request bound. A rate
  // dated after the request is answering a different question; one dated
  // after the current UTC day cannot have been published yet. Either way
  // the preview would show a number the Worker then refuses, and the
  // optimistic amount would jump when the real write lands.
  if (row.date > input.requestedDate || row.date > todayUtc()) {
    throw new Error(`Frankfurter rateDate ${row.date} ahead of requested ${input.requestedDate}`)
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
  const isFutureDate = shapeValid && input.requestedDate > todayLocal()

  let disabledReason: FxPreviewDisabledReason | null = null
  if (!isDegenerate) {
    if (!shapeValid)        disabledReason = 'invalid-input'
    else if (isFutureDate)  disabledReason = 'future-date'
  }

  const pinned  = input.pinned ?? null
  const enabled = !isDegenerate && shapeValid && !isFutureDate && !pinned
  const workerBase = input.tripId ? workerBaseOrNull() : null
  const tripId     = workerBase ? input.tripId! : null

  // Rate adopted from a FX_RATE_CHANGED refusal, scoped to the exact rate
  // key it answered so a date / currency change drops it.
  const rateKey = `${tripId ?? 'direct'}|${input.requestedDate}|${input.sourceCurrency}|${input.tripCurrency}`
  const [adopted, setAdopted] = useState<{ key: string; quote: FxRateQuote; at: number } | null>(null)
  function adoptRate(quote: FxRateQuote) {
    setAdopted({ key: rateKey, quote, at: Date.now() })
  }

  const query = useQuery({
    // Source is part of the key: a Worker answer and a direct provider
    // answer are different claims and must not satisfy each other.
    queryKey: ['fxPreview', tripId ?? 'direct', input.requestedDate, input.sourceCurrency, input.tripCurrency],
    queryFn:  () => (tripId && workerBase
      ? fetchWorkerFxRate({ ...input, tripId }, workerBase)
      : fetchFxRate(input)),
    enabled,
    // A final answer never changes; a provisional one (today's rate before
    // publication) must not be reused, or the preview keeps showing it
    // after the Worker — which caches only final answers — has moved on.
    staleTime: q => isFinalAnswer(q.state.data, input.requestedDate) ? Infinity : 0,
    // While a form stays open across publication, pick the new rate up.
    refetchInterval: q => (q.state.data && !isFinalAnswer(q.state.data, input.requestedDate)
      ? PROVISIONAL_REFETCH_MS
      : false),
    retry:     1,
  })

  if (isDegenerate) {
    return {
      rateDecimal: null, rateDate: null, rateQuote: null, isFinal: true,
      isLoading: false, isError: false,
      isDegenerate: true, disabledReason: null, adoptRate,
    }
  }
  // The newest authoritative observation wins: an adopted 409 rate until a
  // preview fetch lands after it (a pinned rate never refetches).
  const adoptedQuote = adopted && adopted.key === rateKey && !disabledReason
    && (pinned || query.dataUpdatedAt <= adopted.at)
    ? adopted.quote
    : null
  if (adoptedQuote) {
    return {
      rateDecimal: adoptedQuote.rateDecimal, rateDate: adoptedQuote.rateDate, rateQuote: adoptedQuote,
      isFinal: isFinalAnswer(adoptedQuote, input.requestedDate),
      isLoading: false, isError: false,
      isDegenerate: false, disabledReason: null, adoptRate,
    }
  }
  if (pinned && !disabledReason) {
    return {
      rateDecimal: pinned.rateDecimal, rateDate: pinned.rateDate, rateQuote: pinned,
      // The Worker reuses the stored rate for this key; it cannot move.
      isFinal: true,
      isLoading: false, isError: false,
      isDegenerate: false, disabledReason: null, adoptRate,
    }
  }
  const data = query.data ?? null
  return {
    rateDecimal:    data?.rateDecimal ?? null,
    rateDate:       data?.rateDate    ?? null,
    rateQuote:      data,
    isFinal:        isFinalAnswer(data ?? undefined, input.requestedDate),
    isLoading:      enabled && query.isLoading,
    isError:        query.isError,
    isDegenerate:   false,
    disabledReason,
    adoptRate,
  }
}
