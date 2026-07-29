/** Shared request-id shape used by every trip-scoped Worker endpoint. */
export const TripIdRe = /^[A-Za-z0-9_-]{1,60}$/

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
