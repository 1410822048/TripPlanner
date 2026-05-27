// Shared JSON-route dispatch wrapper for index.ts.
//
// Every POST endpoint repeats the same 4-step pipeline after the
// shared CORS / auth / rate-limit / body-size pass:
//
//   1. Zod safeParse(body) — fail → 400 with { error, detail }
//   2. await handler(parsed.data) — happy path
//   3. catch domain error (per-route) → mapped status + body
//   4. catch CascadeError (shared) → e.status, { error: e.message }
//   5. catch generic → 500, { error: 'Internal error' }
//
// `handleJsonRoute` consolidates 1-2-4-5; step 3 is per-route via the
// `catchDomain` hook. Log lines are preserved via `formatLog`/`catchDomain.log`
// so operators see the same `[endpoint] ...` shapes they used to.
//
// Scope kept tight: auth + rate-limit + CORS stay at the fetch handler
// because they're shared across ALL routes (and ordering matters —
// must happen before body parse). This wrapper takes over from the
// point each route diverges.

import type { z } from 'zod'
import { CascadeError } from './cascade'

/** Truncated uid for logs. 6-char prefix + ellipsis is enough to
 *  correlate abuse without retaining a fully-identifying token. */
export function uidTag(uid: string): string {
  return uid.slice(0, 6) + '…'
}

/** Header carrying the upload-flow correlation id minted client-side
 *  by `mintAndUploadEntityIntents`. Echoed into log lines as
 *  `trace=<id>` so an operator can `wrangler tail | grep <id>` to
 *  reconstruct the full mint → upload → write chain from a single
 *  Sentry breadcrumb timestamp. */
export const UPLOAD_TRACE_HEADER = 'X-Upload-Trace-Id'

/** Permissive shape: alphanumeric + dash + underscore, 12-64 chars.
 *  Covers crypto.randomUUID() (36 chars, hex + dashes) plus future
 *  shorter formats without rev'ing the contract. Rejects anything
 *  that could break log-line parsing or carry CRLF injection. */
const TRACE_ID_RE = /^[A-Za-z0-9_-]{12,64}$/

/** Extract + validate the upload-flow traceId from a request. Returns
 *  `undefined` when the header is missing OR malformed -- the route
 *  still serves the request, the log line just omits `trace=`. We
 *  deliberately don't reject on bad format: an upload from a stale
 *  client shouldn't be denied just because its traceId is the wrong
 *  shape. */
export function extractTraceId(request: Request): string | undefined {
  const raw = request.headers.get(UPLOAD_TRACE_HEADER)
  if (!raw) return undefined
  return TRACE_ID_RE.test(raw) ? raw : undefined
}

/** Format the log suffix for a traceId. Empty string when undefined
 *  so callers can splat it into template strings without a conditional. */
function traceSuffix(traceId: string | undefined): string {
  return traceId ? ` trace=${traceId}` : ''
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })
}

/** Per-route domain-error mapping (e.g. ExpenseValidationError →
 *  400 { error, field }, GeminiError → e.status { error }). Return
 *  `null` if the thrown value isn't of the expected domain type; the
 *  dispatcher then falls through to the shared CascadeError + 500
 *  catches. `log` is the suffix appended after `[endpoint] ` in the
 *  warn line. */
export interface DomainErrorMapped {
  log:    string
  body:   unknown
  status: number
}

/** Catcher for the three entity ValidationError classes
 *  (Expense / Wish / Booking) — all share the `{ field, message }`
 *  shape and always map to 400. Saves repeating the 3-line lambda at
 *  every route site. */
export function validationErrorCatcher<E extends { field: string; message: string }>(
  Cls: new (...args: never[]) => E,
): (e: unknown) => DomainErrorMapped | null {
  return e => e instanceof Cls
    ? {
        log:    `validation: ${e.field} ${e.message}`,
        body:   { error: e.message, field: e.field },
        status: 400,
      }
    : null
}

export async function handleJsonRoute<TData, TResult>(args: {
  /** Tag used as `[endpoint]` log prefix; matches the route path
   *  (without leading slash) in existing logs. */
  endpoint:        string
  /** Already JSON-parsed body — caller does the JSON.parse so a route-
   *  level parse error can't masquerade as schema fail. */
  body:            unknown
  cors:            Record<string, string>
  uid:             string
  /** Optional client-supplied upload-flow correlation id. Appended as
   *  `trace=<id>` to every log line produced by this dispatch (success
   *  + warn + error). Pre-validated by `extractTraceId` in the fetch
   *  handler; the wrapper itself trusts the value. */
  traceId?:        string
  schema:          z.ZodType<TData>
  handle:          (data: TData) => Promise<TResult>
  /** Free-form suffix after `[endpoint] uid=<tag> ` on success log.
   *  Receives the parsed data (for inputs like tripId) AND the result
   *  (for outputs like a server-assigned expenseId). */
  formatLog:       (data: TData, result: TResult) => string
  /** Transform the handler result into the JSON response body. Default
   *  is identity. Use for `{ ok: true, ...result }` wrappers on create
   *  endpoints. */
  formatResponse?: (result: TResult) => unknown
  /** Per-route domain-error mapper. Optional — routes without a
   *  domain error class (upload-intents / trip-cascade / cascade-member)
   *  omit this and fall through to the shared CascadeError catch. */
  catchDomain?:    (e: unknown) => DomainErrorMapped | null
}): Promise<Response> {
  const trace = traceSuffix(args.traceId)
  const parsed = args.schema.safeParse(args.body)
  if (!parsed.success) {
    console.warn(`[${args.endpoint}] schema fail: ${parsed.error.message.slice(0, 200)}${trace}`)
    return json({ error: 'Invalid body', detail: parsed.error.message }, 400, args.cors)
  }
  try {
    const result = await args.handle(parsed.data)
    console.log(`[${args.endpoint}] uid=${uidTag(args.uid)} ${args.formatLog(parsed.data, result)}${trace}`)
    return json(args.formatResponse ? args.formatResponse(result) : result, 200, args.cors)
  } catch (e) {
    const domain = args.catchDomain?.(e) ?? null
    if (domain) {
      console.warn(`[${args.endpoint}] ${domain.log}${trace}`)
      return json(domain.body, domain.status, args.cors)
    }
    if (e instanceof CascadeError) {
      console.warn(`[${args.endpoint}] ${e.status} ${e.message}${trace}`)
      return json({ error: e.message }, e.status, args.cors)
    }
    console.error(`[${args.endpoint}] internal error: ${(e as Error).message}${trace}`)
    return json({ error: 'Internal error' }, 500, args.cors)
  }
}
