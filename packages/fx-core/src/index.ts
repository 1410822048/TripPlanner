// @tripmate/fx-core — single source of truth for currency conversion
// math shared between the React client (preview) and the Cloudflare
// Worker (authoritative recompute on expense-write).
//
// Scope is deliberately narrow: pure decimal-rate parsing, integer
// BigInt-backed conversion with banker's rounding, and residual
// allocation for multi-line conversions. No Firestore, no Frankfurter
// fetch, no async, no side effects. Callers (Worker fx-rate.ts, client
// expense preview) own provider IO and snapshot persistence.
//
// Money domain:
//   sourceMinor / targetMinor are POSITIVE OR NEGATIVE integer minor
//   units. Negative covers refunds, which the parser already accepts
//   (see src/utils/money.ts MoneyParseError tests). The rate itself
//   must be a positive decimal string; provider responses are
//   canonicalised via canonicalizeRate before storage.
//
//   sourceFractionDigits / targetFractionDigits are 0-or-2 in practice
//   (JPY/TWD/KRW/VND/IDR = 0; USD/EUR/CNY/HKD/GBP = 2 per app
//   convention). The math accepts any non-negative integer to stay
//   future-proof against 3-fraction currencies (e.g. BHD = 3).
//
// Why this exists:
//   Phase 1 of the FX multicurrency design (see memory:
//   fx-multicurrency-design). Worker validation needs to recompute
//   converted amounts authoritatively and the client needs to preview
//   the same conversion without drift. Mirrored impls are the failure
//   mode this package is shaped to prevent — same as settlement-core
//   and expense-materialize before it.

// ─── Public types ─────────────────────────────────────────────────

/** Parsed canonical decimal rate. `value = mantissa / 10^scale`.
 *  Example: "146.2" → { mantissa: 1462n, scale: 1 };
 *           "0.00684" → { mantissa: 684n, scale: 5 }. */
export interface ParsedRate {
  mantissa: bigint
  scale:    number
}

/** Conversion problem statement. Caller adapts whatever it has into
 *  this shape — no currency code is needed here, only fraction-digit
 *  count. The CALLER is responsible for looking up fraction digits
 *  from the currency code (see src/utils/money.ts
 *  currencyFractionDigits). Decoupling here lets fx-core stay free of
 *  the currency registry, which lives in the app domain. */
export interface ConvertMinorInput {
  sourceMinor:          number
  rateDecimal:          string
  sourceFractionDigits: number
  targetFractionDigits: number
}

// ─── Canonical-form helpers ───────────────────────────────────────

/** Validate a string is in canonical decimal form for a STRICTLY
 *  POSITIVE rate. Accepts `"1"`, `"146.2"`, `"0.912345"`, `"0.00684"`.
 *  Rejects scientific notation, leading `+`, leading zeros (`"01.2"`),
 *  trailing zeros after a decimal point (`"1.20"`), bare decimal
 *  points (`"1."`, `".5"`), empty string, whitespace, negative values,
 *  AND `"0"` (zero is not a valid FX rate — see below).
 *
 *  Storage uses one canonical form so cache hits are byte-stable and
 *  replay produces identical results.
 *
 *  Why strict: the Worker reads `rateDecimal` from Firestore and feeds
 *  it back into convertMinorHalfEven. If the same logical rate has
 *  multiple encodings (e.g. "1.0" vs "1"), two trips with the same
 *  effective rate would produce two different cache docs, doubling
 *  storage and breaking the "audit single-source" goal.
 *
 *  Why zero is rejected: a valid FX rate is strictly positive. If a
 *  bug ever wrote `"0"` into a Firestore cache doc, every conversion
 *  off that rate would silently materialise as 0 minor units — a
 *  whole class of expenses zeroed out without any error surface. The
 *  contract is "reject at the boundary, not silently swallow"
 *  ([[feedback-optimal-first]]). */
export function isCanonicalRateString(input: string): boolean {
  if (typeof input !== 'string' || input.length === 0) return false
  // Reject leading + and signs entirely (rate is positive). Empty
  // after sign was the failure mode for `+"5"` → "5" silent acceptance.
  if (input[0] === '+' || input[0] === '-')            return false
  // Strict regex: positive integer OR "0.<digits ending in 1-9>" OR
  //               positive integer with optional ".<digits ending in 1-9>".
  // The `0` branch REQUIRES a fractional part with a non-zero last
  // digit, so bare `"0"` and `"0.0"` both fail.
  // Examples in/out: "1" ✓, "0.5" ✓, "146.2" ✓, "0.00684" ✓,
  //                  "0" ✗, "0.0" ✗, "01" ✗, "1.20" ✗, "1." ✗,
  //                  ".5" ✗, "1e2" ✗.
  return /^(0\.\d*[1-9]|[1-9]\d*(\.\d*[1-9])?)$/.test(input)
}

/** Normalise a provider rate (Frankfurter returns JSON number) into the
 *  canonical decimal string isCanonicalRateString accepts. Strips
 *  trailing zeros, removes the decimal point when no fractional digits
 *  remain, and rejects non-finite / non-positive / scientific-notation
 *  inputs (provider should never emit those, but defence in depth).
 *
 *  Why we accept number as input: Frankfurter v2 returns rates as JSON
 *  numbers (`{ rate: 146.2 }`). Worker decodes JSON → number, hands to
 *  this canoniser before persisting. Client previews convert via the
 *  same path. */
export function canonicalizeRate(input: number | string): string {
  if (typeof input === 'string') {
    // Pre-canonical: strict parser already accepts → return as-is.
    if (isCanonicalRateString(input)) return input
    // Otherwise fall through to numeric normalisation. The fixed-point
    // route below handles "1.0" → "1", "1.200" → "1.2", etc.
    const asNumber = Number(input)
    if (!Number.isFinite(asNumber)) {
      throw new Error(`fx-core: rate input not finite: ${input}`)
    }
    if (asNumber <= 0) {
      throw new Error(`fx-core: rate input not positive: ${input}`)
    }
    return canonicalizeRate(asNumber)
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw new Error(`fx-core: rate input invalid: ${input}`)
  }
  // toFixed up to 12 decimal places; far beyond Frankfurter's 6-digit
  // precision but covers any future provider without precision loss
  // for typical FX magnitudes. Then strip trailing zeros and a bare
  // trailing decimal point.
  const fixed   = input.toFixed(12)
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '')
  if (!isCanonicalRateString(trimmed)) {
    throw new Error(`fx-core: canonicalisation produced non-canonical: ${trimmed}`)
  }
  return trimmed
}

// ─── Public parsing ───────────────────────────────────────────────

/** Parse a canonical decimal rate string into { mantissa, scale } via
 *  BigInt. The string MUST already be canonical (see
 *  isCanonicalRateString). Use canonicalizeRate first if unsure. */
export function parseDecimalRate(input: string): ParsedRate {
  if (!isCanonicalRateString(input)) {
    throw new Error(`fx-core: parseDecimalRate received non-canonical input: ${input}`)
  }
  const dotIndex = input.indexOf('.')
  if (dotIndex < 0) {
    return { mantissa: BigInt(input), scale: 0 }
  }
  const whole    = input.slice(0, dotIndex)
  const fraction = input.slice(dotIndex + 1)
  const mantissa = BigInt(whole + fraction)
  return { mantissa, scale: fraction.length }
}

// ─── Internal: BigInt half-even round ─────────────────────────────

/** Half-even (banker's) rounding on a BigInt division: returns the
 *  rounded quotient of `numerator / denominator`. Operates on absolute
 *  values then re-applies the sign so negative inputs round
 *  symmetrically (refund parity with positive amounts).
 *
 *  Half-even policy: when remainder is exactly half the denominator,
 *  round to the even quotient. Required for unbiased aggregation across
 *  many small-value lines (item-by-item conversion at scale). */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('fx-core: divRoundHalfEven denominator must be positive')
  }
  const sign    = numerator < 0n ? -1n : 1n
  const absNum  = numerator < 0n ? -numerator : numerator
  const quot    = absNum / denominator
  const rem     = absNum % denominator
  const twiceRem = rem * 2n
  let rounded   = quot
  if (twiceRem > denominator) {
    rounded = quot + 1n
  } else if (twiceRem === denominator) {
    // Exact half — round to even
    if (quot % 2n !== 0n) rounded = quot + 1n
  }
  return sign * rounded
}

// ─── Public conversion ────────────────────────────────────────────

/** Convert one minor-unit amount via the supplied canonical decimal
 *  rate using BigInt arithmetic + half-even rounding.
 *
 *  Math:
 *    targetMinor = round_half_even(
 *      sourceMinor * mantissa * 10^targetFractionDigits
 *      / 10^(sourceFractionDigits + scale)
 *    )
 *
 *  Worked examples:
 *    USD 12.34 (sourceMinor=1234, sf=2) × rate "146.2" → JPY ¥1804 (tf=0)
 *      num = 1234 * 1462 * 1   = 1,804,108
 *      den = 10^(2+1)          = 1,000
 *      1804108 / 1000          = 1804 rem 108  → 1804
 *    JPY ¥1000 (sourceMinor=1000, sf=0) × rate "0.00684" → USD $6.84 (tf=2)
 *      num = 1000 * 684 * 100  = 68,400,000
 *      den = 10^(0+5)          = 100,000
 *      68400000 / 100000       = 684 rem 0     → 684
 *
 *  Caller is responsible for ensuring `sourceMinor` is an integer and
 *  the fraction-digit counts are non-negative. */
export function convertMinorHalfEven(args: ConvertMinorInput): number {
  const { sourceMinor, rateDecimal, sourceFractionDigits, targetFractionDigits } = args
  if (!Number.isInteger(sourceMinor)) {
    throw new Error(`fx-core: sourceMinor must be integer, got ${sourceMinor}`)
  }
  if (!Number.isInteger(sourceFractionDigits) || sourceFractionDigits < 0) {
    throw new Error(`fx-core: sourceFractionDigits must be non-negative integer`)
  }
  if (!Number.isInteger(targetFractionDigits) || targetFractionDigits < 0) {
    throw new Error(`fx-core: targetFractionDigits must be non-negative integer`)
  }
  const { mantissa, scale } = parseDecimalRate(rateDecimal)
  // Build numerator and denominator entirely in BigInt to dodge JS
  // float traps (`0.1 + 0.2 !== 0.3`).
  const numerator   = BigInt(sourceMinor) * mantissa * (10n ** BigInt(targetFractionDigits))
  const denominator = 10n ** BigInt(sourceFractionDigits + scale)
  const rounded     = divRoundHalfEven(numerator, denominator)
  // Convert back to Number at the boundary. Result fits Number safely
  // for any sane FX magnitude: max realistic source ~1e9 minor (¥1B
  // expense), max rate mantissa ~1e7 (rare extreme), target fraction
  // ≤2 → ~1e18, still within BigInt range; the divided result is on
  // the same order of magnitude as sourceMinor and fits Number.
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new Error(`fx-core: converted result exceeds safe-integer range: ${rounded}`)
  }
  return Number(rounded)
}

// ─── Public residual allocation ───────────────────────────────────

/** Reconcile per-line conversions against the authoritative total.
 *  Given N already-converted lines and an INDEPENDENTLY converted
 *  authoritative total, distribute `targetTotal - sum(lines)` to the
 *  largest-absolute-value line. Returns a new array; input is not
 *  mutated.
 *
 *  Why largest line gets the residual: the relative error introduced
 *  is smallest there, so the user-visible distortion is minimised.
 *  Ties (e.g. two equal-size items) break by index (first wins) for
 *  deterministic replay across client preview and Worker recompute.
 *
 *  Empty input + non-zero target → throws (caller bug: can't allocate
 *  residual to no lines). Empty input + zero target → returns []. */
export function allocateRoundingResidual(args: {
  lines:       number[]
  targetTotal: number
}): number[] {
  const { lines, targetTotal } = args
  if (!Array.isArray(lines)) {
    throw new Error('fx-core: lines must be an array')
  }
  if (!Number.isInteger(targetTotal)) {
    throw new Error(`fx-core: targetTotal must be integer, got ${targetTotal}`)
  }
  for (const value of lines) {
    if (!Number.isInteger(value)) {
      throw new Error(`fx-core: line value must be integer, got ${value}`)
    }
  }
  if (lines.length === 0) {
    if (targetTotal === 0) return []
    throw new Error(`fx-core: cannot allocate residual ${targetTotal} to empty lines`)
  }
  let sum = 0
  for (const value of lines) sum += value
  const residual = targetTotal - sum
  if (residual === 0) return [...lines]
  // Find index of largest |line|; ties → first index (stable).
  let maxIndex = 0
  let maxAbs   = Math.abs(lines[0]!)
  for (let i = 1; i < lines.length; i++) {
    const abs = Math.abs(lines[i]!)
    if (abs > maxAbs) {
      maxAbs   = abs
      maxIndex = i
    }
  }
  const result = [...lines]
  result[maxIndex] = result[maxIndex]! + residual
  return result
}
