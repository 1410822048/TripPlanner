/** Shared request-id shape used by every trip-scoped Worker endpoint. */
export const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

/** Verbatim mirror of `isHttpUrl` in src/types/_shared.ts, guarding the
 *  `link` field on both booking and wish. The Worker uses the admin SDK
 *  and bypasses firestore.rules, so its check must match the rules'
 *  canonical set EXACTLY — anything it accepts but the rules
 *  `^https?://.+` regex rejects (uppercase scheme, embedded whitespace;
 *  both of which `new URL()` would silently accept) gets written to the
 *  doc and then jams every later client update. Lowercase http(s)://
 *  prefix + no whitespace, then parse. */
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

/**
 * Common validation-error contract consumed by validationErrorCatcher.
 * Domain subclasses retain their public class names and instanceof checks.
 */
export class FieldValidationError extends Error {
  readonly field: string

  constructor(name: string, field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = name
    this.field = field
  }
}
