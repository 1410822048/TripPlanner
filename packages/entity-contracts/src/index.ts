// @tripmate/entity-contracts — field limits and small validators that the
// client schemas, the form inputs and the Worker validators must agree on.
//
// Before this package each limit lived in up to four places (client zod,
// Worker zod, form maxLength, firestore.rules) and they drifted: the Worker
// accepted 200-character expense titles that the client then refused to
// read, notes were capped only after the form had closed, and so on. Code
// imports from here; firestore.rules and firebase-functions cannot, so
// tests/invariants/entityContracts.test.ts compares the rules against these
// numbers.
//
// Dependency-free on purpose: the Worker bundle, the browser bundle and the
// tests all pull it in.

/** Firebase uid length cap used wherever a uid is accepted. */
export const UID_MAX = 128

/** Client-minted entity / line ids (expense item, adjustment). */
export const ENTITY_ID_MAX = 64

/** Stored attachment object paths. */
export const ATTACHMENT_PATH_MAX = 500

/** Per-file attachment ceiling (receipts, booking documents, wish images). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Upper bound for any single money amount in minor units. */
export const MAX_AMOUNT_MINOR = 1_000_000_000

export const EXPENSE_LIMITS = {
  title:          100,
  note:           1000,
  itemName:       200,
  adjustmentLabel: 120,
  splits:         50,
  items:          100,
  adjustments:    50,
  allocations:    50,
  allocationShares: 999,
} as const

export const BOOKING_LIMITS = {
  title:            100,
  origin:           60,
  destination:      60,
  confirmationCode: 64,
  provider:         60,
  /** checkIn / checkOut as typed (ISO date or date-time text). */
  dateText:         32,
  address:          500,
  link:             500,
  note:             2000,
} as const

export const WISH_LIMITS = {
  title:       100,
  description: 500,
  link:        500,
  address:     500,
} as const

export const SETTLEMENT_LIMITS = {
  note: 200,
  /** Lineage expense titles are written truncated to EXPENSE_LIMITS.title
   *  (+ ellipsis); reads accept up to this so legacy rows still parse. */
  lineageTitleRead: 200,
} as const

/** Receipt / expense adjustment kinds, in display order. */
export const ADJUSTMENT_KINDS = [
  'DISCOUNT', 'COUPON', 'TAX_EXEMPT', 'SURCHARGE', 'TAX', 'TIP', 'OTHER',
] as const
export type AdjustmentKindName = typeof ADJUSTMENT_KINDS[number]

// The package compiles against plain ES2022 (no DOM / workers lib); every
// runtime that loads it (browser, workerd, node) provides WHATWG URL.
declare const URL: new (input: string) => unknown

/** http(s) URL check shared by every `link` field. Rejects other schemes
 *  (javascript:, data:) because links render into <a href>, rejects
 *  whitespace, and requires the URL parser to accept it. */
export function isHttpUrl(v: string): boolean {
  if (!v.startsWith('http://') && !v.startsWith('https://')) return false
  if (/\s/.test(v)) return false
  try {
    new URL(v)
    return true
  } catch {
    return false
  }
}
