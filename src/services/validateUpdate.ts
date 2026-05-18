// src/services/validateUpdate.ts
// Defense-in-depth validation for update mutations. The TS form layer
// gates the shape at the call site, but the service boundary re-checks
// via Zod so any future code path that bypasses the typed form (eg.
// quick-edit shortcuts, future bulk-import flows) can't corrupt the
// Firestore doc — and so Sentry sees a clean stack trace tagged with
// the offending entity when corruption attempts arrive.
//
// Returns `parsed.data` so callers can `const validated = validateUpdateOrThrow(...)`
// in one line instead of repeating the safeParse + captureError + throw
// trio in every update fn.
import type { z, ZodError, ZodTypeAny } from 'zod'
import { captureError } from '@/services/sentry'

export function validateUpdateOrThrow<S extends ZodTypeAny>(
  schema: S,
  data:   unknown,
  ctx:    { source: string } & Record<string, unknown>,
): z.infer<S> {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    captureError(parsed.error as ZodError, ctx)
    throw new Error('Update payload failed validation')
  }
  return parsed.data
}
