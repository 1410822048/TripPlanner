// src/types/_shared.ts
// Cross-entity zod helpers. Importing from `_shared` (underscore prefix
// keeps it visually distinct from entity files like `trip.ts` /
// `booking.ts`) makes it clear at a glance that this isn't a domain
// type — it's plumbing.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'

/**
 * Duck-type Firestore Timestamp validator. We don't `instanceof Timestamp`
 * because that would force a runtime import of the firebase/firestore
 * class — defeating the lazy-loading dance we do in services/firebase.ts.
 * The shape check (object with toDate fn) is sufficient: real Timestamps
 * pass; mock fixtures (mocks/utils.MOCK_TIMESTAMP) also pass; anything
 * else fails parsing.
 */
export const TimestampSchema = z.custom<Timestamp>(
  v => v != null && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function',
  { message: 'Expected Firestore Timestamp' },
)

/** ISO 4217 alpha-3 uppercase currency code. Shared across trips
 *  (currency), expenses (currency / sourceCurrency / fxSnapshot.base /
 *  fxSnapshot.quote), and settlements (currency / sourceCurrency /
 *  fxSnapshot pair). One regex, one contract. */
export const CurrencyCodeSchema = z.string().regex(
  /^[A-Z]{3}$/,
  'currency must be ISO 4217 alpha-3 uppercase',
)

/** ISO date 'YYYY-MM-DD' shape. Same form is used by expense.date,
 *  fxSnapshot.requestedDate / rateDate, and settlement.settledOn. */
export const IsoDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  'date must be YYYY-MM-DD',
)

/** Canonical decimal rate string — STRICTLY POSITIVE, no trailing
 *  zeros, no leading zeros beyond a single `0` before a `.`, at least
 *  one digit. Mirrors `@tripmate/fx-core::isCanonicalRateString` byte-
 *  for-byte. Local regex (vs importing isCanonicalRateString) keeps
 *  the read schema free of the fx-core runtime dep — read paths
 *  execute in client bundles where bundle weight matters.
 *
 *  Zero is rejected (`"0"`, `"0.0"`, `"0.00"` etc.): a valid FX rate
 *  is strictly positive, and a bug ever writing `"0"` into a Firestore
 *  doc would silently materialise every conversion as 0 minor units —
 *  fail fast at the parse boundary instead. */
export const CanonicalRateDecimalSchema = z.string().regex(
  /^(0\.\d*[1-9]|[1-9]\d*(\.\d*[1-9])?)$/,
  'rateDecimal must be canonical positive decimal (no trailing zeros, non-zero)',
)

/** FxSnapshot read schema — Worker-minted record of one FX conversion
 *  event, persisted on the expense / settlement doc it belongs to. The
 *  Worker is authoritative for writes (foreign-mode router in
 *  expense-write.ts; settlement Worker in Commit 2 of the Settlement
 *  FX rollout); this schema gates reads so any drift surfaces via the
 *  same firestoreDocFromSchema Sentry path as other doc-level schema
 *  regressions.
 *
 *  Cross-field equality with the parent doc (sourceCurrency ===
 *  baseCurrency, amountMinor === convertedAmountMinor, etc.) is
 *  enforced by the parent doc's own superRefine — this schema only
 *  validates the snapshot's internal shape. */
export const FxSnapshotSchema = z.object({
  provider:             z.literal('frankfurter-v2'),
  baseCurrency:         CurrencyCodeSchema,
  quoteCurrency:        CurrencyCodeSchema,
  requestedDate:        IsoDateSchema,
  rateDate:             IsoDateSchema,
  rateDecimal:          CanonicalRateDecimalSchema,
  sourceAmountMinor:    z.number().int().positive(),
  convertedAmountMinor: z.number().int().nonnegative(),
  fetchedAt:            TimestampSchema,
})

/** Derived FxSnapshot type. Entity files (expense.ts, settlement.ts)
 *  import this directly so the type and the schema can never drift
 *  out of sync. */
export type FxSnapshot = z.infer<typeof FxSnapshotSchema>
