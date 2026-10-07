/** Shared request-id shape used by every trip-scoped Worker endpoint. */
export const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

/** The shared `link` check (lowercase http(s) prefix, no whitespace, then
 *  URL parse) — one definition for client and Worker; the Worker bypasses
 *  firestore.rules, so it must accept exactly what the rules regex does. */
export { isHttpUrl } from '@tripmate/entity-contracts'

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
