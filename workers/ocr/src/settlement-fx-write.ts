// workers/ocr/src/settlement-fx-write.ts
// Foreign-currency domain for the settlement-create endpoint: FX rate
// resolution, source-amount derivation, and the Firestore encoder for the
// persisted fxSnapshot mirror. Split out of settlement-write.ts (boundary
// extraction) so the orchestrator imports a named FX boundary rather than
// inlining rate I/O + half-even money math next to auth + tx plumbing.
//
// Phase 4.1 ledger semantics (2026-06-02): settlement.amountMinor ≡
// remaining (full clear). FX does NOT derive amountMinor; it only
// populates the source-side display + audit (sourceAmountMinor +
// fxSnapshot.convertedAmountMinor), which may be ≤ amountMinor by a few
// minor units due to half-even rounding plateaus.
//
// The prep is split in two so the NETWORK half runs OUTSIDE the pair-docs
// conflict window (see doCreate in settlement-write.ts): resolveForeignRate
// does the FX I/O BEFORE the pair fan-out; deriveForeignArtifacts is
// pure-CPU and runs AFTER `remaining` is known. Keeping that ordering is
// load-bearing — the orchestrator calls resolveForeignRate before reading
// any pair doc so a slow FX provider can't lengthen the tx conflict window.
import { CascadeError }                    from './cascade'
import { resolveFxRate, type FxSnapshot }  from './fx-rate'
import {
  currencyFractionDigits,
  convertMinorHalfEven,
  estimateSourceMinorAtMostTargetHalfEven,
}                                          from '@tripmate/fx-core'
import { type FsValue }                    from './firestore'
import {
  SettlementValidationError,
  type TripCurrencyContext,
  type SettlementCreateForeignRequest,
}                                          from './settlement-write-shared'

/** Carries the source-domain artifacts that FOREIGN_CURRENCY persists
 *  alongside the trip-currency canonical fields. Mirrors expense-write's
 *  ForeignArtifacts pattern: snapshot.fetchedAt is encoded as null and
 *  REQUEST_TIME-stamped at commit. */
export interface ForeignSettlementArtifacts {
  sourceCurrency:    string
  sourceAmountMinor: number
  settledOn:         string
  fxSnapshot:        FxSnapshot
}

/** The FX rate + fraction-digit context resolved before the pair fan-out.
 *  Carries everything deriveForeignArtifacts needs so that step touches no
 *  network. `rate` is the non-null result of resolveFxRate. */
export interface ForeignRate {
  rate:                 NonNullable<Awaited<ReturnType<typeof resolveFxRate>>>
  sourceFractionDigits: number
  targetFractionDigits: number
}

/** Encode FxSnapshot as a Firestore map. `fetchedAt` is set to null
 *  here -- the caller adds an `updateTransforms` entry pinned to
 *  REQUEST_TIME so Firestore stamps the field at commit. Writing both
 *  is intentional: the field MUST appear in the map so the create
 *  Write's `currentDocument.exists=false` doesn't reject the transform
 *  as targeting a missing parent.
 *
 *  Inline (vs sharing from fx-rate.ts with expense-write) is deliberate:
 *  both writers shaping the same fxSnapshot map keeps the contract
 *  obvious at the write site, and the read-schema test
 *  (settlement.test.ts FX cross-field equality) catches any divergence. */
export function encodeFxSnapshot(fx: FxSnapshot): FsValue {
  return {
    mapValue: {
      fields: {
        provider:             { stringValue:  fx.provider },
        baseCurrency:         { stringValue:  fx.baseCurrency },
        quoteCurrency:        { stringValue:  fx.quoteCurrency },
        requestedDate:        { stringValue:  fx.requestedDate },
        rateDate:             { stringValue:  fx.rateDate },
        rateDecimal:          { stringValue:  fx.rateDecimal },
        sourceAmountMinor:    { integerValue: String(fx.sourceAmountMinor) },
        convertedAmountMinor: { integerValue: String(fx.convertedAmountMinor) },
        fetchedAt:            { nullValue:    null },
      },
    },
  }
}

/** NETWORK half. Rejects same-currency (caller should use TRIP_CURRENCY),
 *  then resolves the FX rate for (sourceCurrency, tripCurrency, settledOn)
 *  via the cache-aware `resolveFxRate`. FxError bubbles to the route
 *  handler → 4xx/5xx per fx-rate.ts's FxErrorCode → status mapping. Runs
 *  before the pair fan-out, so an FX failure is definitively pre-commit
 *  (no pair doc has been read, nothing written). */
export async function resolveForeignRate(
  req:                SettlementCreateForeignRequest,
  ctx:                TripCurrencyContext,
  serviceAccountJson: string,
): Promise<ForeignRate> {
  if (req.sourceCurrency === ctx.currency) {
    throw new SettlementValidationError(
      'sourceCurrency',
      `sourceCurrency ${req.sourceCurrency} equals trip currency; use the trip-currency settlement path instead`,
    )
  }

  const rate = await resolveFxRate(
    {
      requestedDate:  req.settledOn,
      sourceCurrency: req.sourceCurrency,
      tripCurrency:   ctx.currency,
    },
    serviceAccountJson,
  )
  if (!rate) {
    // Defensive: resolveFxRate returns null only when source === trip,
    // which we explicitly rejected above. Reaching here means a logic
    // drift; fail closed rather than persist a partial doc.
    throw new CascadeError(500, 'unexpected null rate for foreign settlement (source !== trip)')
  }

  return {
    rate,
    sourceFractionDigits: currencyFractionDigits(req.sourceCurrency),
    targetFractionDigits: currencyFractionDigits(ctx.currency),
  }
}

/** PURE-CPU half. Inverse-derives `sourceAmountMinor` via at-most-target
 *  policy (largest non-negative source minor whose forward conversion does
 *  NOT exceed `remaining`; may be 0 for weak rates against tiny remaining —
 *  caller rejects with SettlementValidationError('sourceCurrency')), then
 *  forward-converts to fill fxSnapshot.convertedAmountMinor (audit). No
 *  network — uses the rate resolved earlier by resolveForeignRate. */
export function deriveForeignArtifacts(
  req:       SettlementCreateForeignRequest,
  ctx:       TripCurrencyContext,
  remaining: number,
  fr:        ForeignRate,
): ForeignSettlementArtifacts {
  const sourceAmountMinor = estimateSourceMinorAtMostTargetHalfEven({
    targetMinor:          remaining,
    rateDecimal:          fr.rate.rateDecimal,
    sourceFractionDigits: fr.sourceFractionDigits,
    targetFractionDigits: fr.targetFractionDigits,
  })

  const convertedAmountMinor = convertMinorHalfEven({
    sourceMinor:          sourceAmountMinor,
    rateDecimal:          fr.rate.rateDecimal,
    sourceFractionDigits: fr.sourceFractionDigits,
    targetFractionDigits: fr.targetFractionDigits,
  })

  const fxSnapshot: FxSnapshot = {
    provider:             'frankfurter-v2',
    baseCurrency:         req.sourceCurrency,
    quoteCurrency:        ctx.currency,
    requestedDate:        req.settledOn,
    rateDate:             fr.rate.rateDate,
    rateDecimal:          fr.rate.rateDecimal,
    sourceAmountMinor,
    convertedAmountMinor,
    fetchedAtMs:          fr.rate.fetchedAtMs,
  }

  return {
    sourceCurrency:    req.sourceCurrency,
    sourceAmountMinor,
    settledOn:         req.settledOn,
    fxSnapshot,
  }
}
