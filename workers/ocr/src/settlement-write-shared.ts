// workers/ocr/src/settlement-write-shared.ts
// Cross-cutting substrate shared by the settlement-write orchestration
// (settlement-write.ts) and its domain sub-modules — settlement-fx-write.ts
// (foreign FX) and settlement-lock-write.ts (pair / expense locks): the
// request schemas + inferred types, the validation-error class, and the
// trip-currency auth context. Split out of settlement-write.ts (boundary
// extraction) so the FX module can throw SettlementValidationError and take
// the request / context types WITHOUT importing back into the orchestration
// module — the same cycle-avoidance role expense-write-shared.ts /
// expense-validate.ts play for the expense path.
//
// Settlement's validation surface is small (no per-line materialize, no
// cross-field reconciliation), so a single shared module is proportionate
// here — unlike expense, which warrants a separate expense-validate.ts.
import { z } from 'zod'
import { SETTLEMENT_LIMITS, UID_MAX } from '@tripmate/entity-contracts'
import { FieldValidationError, TripIdRe } from './field-validation'
import { ExpectedFxRateSchema } from './fx-rate'
import { MAX_ROUTE_LEGS, ROUTE_ID_MAX } from '@tripmate/settlement-core'

// ─── Request body schemas ─────────────────────────────────────────

const AMOUNT_MINOR_MAX = 999_999_999_999

/** Settlement create request. Discriminated by `mode`:
 *
 *    - TRIP_CURRENCY (degenerate): client just declares "clear the
 *      remaining debt from fromUid to toUid in trip currency".
 *      No amount on the wire — Worker computes pair-remaining and
 *      writes it as the canonical amountMinor.
 *    - FOREIGN_CURRENCY: client picks the currency the payee actually
 *      received + the date that pins the FX rate. Worker resolves the
 *      rate, inverse-derives the source amount whose forward conversion
 *      does NOT exceed remaining (at-most-target policy), persists the
 *      forward-converted canonical alongside the source-domain trio +
 *      fxSnapshot.
 *
 *  Key shape change from the pre-rearchitecture design: the wire body
 *  no longer carries `amountMinor` / `currency` / `sourceAmountMinor`.
 *  Removing them eliminates the OVERPAY class of bug entirely — the
 *  client can no longer specify a value the Worker has to reject. The
 *  Worker is the sole authority for the canonical settlement amount,
 *  derived from pair-remaining at tx time.
 *
 *  Per-branch `.strict()` rejects extras at the protocol layer so we
 *  don't rely solely on firestore.rules' missing `keys().hasOnly()`
 *  gate. settlementId is client-minted via `crypto.randomUUID()` so
 *  the Worker's `currentDocument.exists=false` gives genuine
 *  create-only semantics (retry-safe). */
const CurrencyRe = /^[A-Z]{3}$/
const IsoDateRe  = /^\d{4}-\d{2}-\d{2}$/

const SettlementCreateBaseSchema = z.object({
  tripId:       z.string().regex(TripIdRe),
  settlementId: z.string().regex(TripIdRe),
  fromUid:      z.string().min(1).max(UID_MAX),
  toUid:        z.string().min(1).max(UID_MAX),
  expectedRemainingMinor: z.number().int().positive().max(AMOUNT_MINOR_MAX),
  note:         z.string().max(SETTLEMENT_LIMITS.note).optional(),
})

const SettlementCreateTripSchema = SettlementCreateBaseSchema.extend({
  mode: z.literal('TRIP_CURRENCY'),
}).strict()

const SettlementCreateForeignSchema = SettlementCreateBaseSchema.extend({
  mode:           z.literal('FOREIGN_CURRENCY'),
  sourceCurrency: z.string().regex(CurrencyRe, 'sourceCurrency must be ISO 4217 alpha-3 uppercase'),
  settledOn:      z.string().regex(IsoDateRe, 'settledOn must be YYYY-MM-DD'),
  /** The rate the receiver last confirmed (FX CAS, fx-rate.ts
   *  assertExpectedFxRate). */
  expectedFxRate: ExpectedFxRateSchema,
}).strict()

export const SettlementCreateRequestSchema = z.discriminatedUnion('mode', [
  SettlementCreateTripSchema,
  SettlementCreateForeignSchema,
])
export type SettlementCreateRequest        = z.infer<typeof SettlementCreateRequestSchema>
export type SettlementCreateTripRequest    = z.infer<typeof SettlementCreateTripSchema>
export type SettlementCreateForeignRequest = z.infer<typeof SettlementCreateForeignSchema>

/** Routed settlement create (/settlement-route-create). A route is a set of
 *  ordinary pair settlements (legs) on real debt edges, recorded together:
 *
 *    - TRANSFER: the receiver confirms the payer paid them `amountMinor`
 *      (trip currency); intermediates net to zero. Optional foreign trio
 *      (sourceCurrency / settledOn / expectedFxRate), all-or-none.
 *    - OFFSET: a debt cycle cleared with no money moving.
 *
 *  Every leg carries `expectedRemainingMinor`, the edge's remaining when the
 *  client planned it — a per-edge CAS the Worker re-checks against its own
 *  ledger (409 SETTLEMENT_STALE). The Worker never trusts the route: shape
 *  (conservation, acyclic / connected, caps) is re-validated with the
 *  shared validateRouteShape, and amounts against the live remaining.
 *  Leg doc ids are derived from `routeId` (routeLegId), never sent. */
const RouteIdRe = new RegExp(`^[A-Za-z0-9_-]{1,${ROUTE_ID_MAX}}$`)

const RouteLegRequestSchema = z.object({
  fromUid:                z.string().min(1).max(UID_MAX),
  toUid:                  z.string().min(1).max(UID_MAX),
  amountMinor:            z.number().int().positive().max(AMOUNT_MINOR_MAX),
  expectedRemainingMinor: z.number().int().positive().max(AMOUNT_MINOR_MAX),
}).strict()

const RouteBaseSchema = z.object({
  tripId:  z.string().regex(TripIdRe),
  routeId: z.string().regex(RouteIdRe),
  legs:    z.array(RouteLegRequestSchema).min(1).max(MAX_ROUTE_LEGS),
  note:    z.string().max(SETTLEMENT_LIMITS.note).optional(),
})

const RouteTransferSchema = RouteBaseSchema.extend({
  kind:           z.literal('TRANSFER'),
  payerUid:       z.string().min(1).max(UID_MAX),
  receiverUid:    z.string().min(1).max(UID_MAX),
  amountMinor:    z.number().int().positive().max(AMOUNT_MINOR_MAX),
  sourceCurrency: z.string().regex(CurrencyRe, 'sourceCurrency must be ISO 4217 alpha-3 uppercase').optional(),
  settledOn:      z.string().regex(IsoDateRe, 'settledOn must be YYYY-MM-DD').optional(),
  expectedFxRate: ExpectedFxRateSchema.optional(),
}).strict()

const RouteOffsetSchema = RouteBaseSchema.extend({
  kind: z.literal('OFFSET'),
}).strict()

export const SettlementRouteCreateRequestSchema = z.discriminatedUnion('kind', [
  RouteTransferSchema,
  RouteOffsetSchema,
]).superRefine((data, ctx) => {
  data.legs.forEach((leg, i) => {
    if (leg.amountMinor > leg.expectedRemainingMinor) {
      ctx.addIssue({ code: 'custom', path: ['legs', i, 'amountMinor'], message: 'leg amount exceeds the edge remaining it was planned against' })
    }
  })
  if (data.kind === 'TRANSFER') {
    const present = [data.sourceCurrency, data.settledOn, data.expectedFxRate].filter(v => v !== undefined).length
    if (present !== 0 && present !== 3) {
      ctx.addIssue({ code: 'custom', path: ['sourceCurrency'], message: 'sourceCurrency, settledOn and expectedFxRate must be sent together' })
    }
  }
})
export type SettlementRouteCreateRequest = z.infer<typeof SettlementRouteCreateRequestSchema>

export const SettlementDeleteRequestSchema = z.object({
  tripId:       z.string().regex(TripIdRe),
  settlementId: z.string().regex(TripIdRe),
}).strict()
export type SettlementDeleteRequest = z.infer<typeof SettlementDeleteRequestSchema>

// ─── Validation error ─────────────────────────────────────────────

/** Thrown for any settlement validation failure. Mirrors the
 *  Expense/Wish/Booking shape so route-dispatch.validationErrorCatcher
 *  handles all four the same way. */
export class SettlementValidationError extends FieldValidationError {
  constructor(field: string, message: string) {
    super('SettlementValidationError', field, message)
  }
}

// ─── Auth context ─────────────────────────────────────────────────

/** Trip-scoped currency context produced by the create flow's
 *  membership/auth check (authorizeMemberTx) and threaded into the FX
 *  derivation. Every settlement in a trip clears debt in this currency;
 *  FOREIGN_CURRENCY only changes the displayed source side, never the
 *  canonical ledger currency. */
export interface TripCurrencyContext {
  currency: string
}
