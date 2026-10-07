// ─── /fx-rate: FX preview from the same source the write path uses ──
//
// The expense form and the settlement sheet used to preview conversions
// with a rate fetched straight from Frankfurter in the browser, while the
// Worker converts with the rate cached in fxRates/{date}_{base}_{quote} —
// the FIRST answer it ever got for that key, which can be the previous
// day's rate if the key was first asked before the ECB published. The two
// could disagree, so the amount the user saw was not the amount that got
// saved. This endpoint answers from the same resolveFxRate (cache first;
// on a miss it fetches and pins the rate), so the preview IS the rate the
// next save will use.
//
// Gate: any active member of the trip (viewers record settlements too).
// The trip currency comes from the trip doc, never from the client.

import { z } from 'zod'
import { readString }                  from './firestore'
import { CascadeError }                from './cascade'
import { readTripAccess }              from './membership-shared'
import { TripIdRe }                    from './field-validation'
import { resolveFxRate }               from './fx-rate'

export const FxPreviewRequestSchema = z.object({
  tripId:         z.string().regex(TripIdRe),
  requestedDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
}).strict()
export type FxPreviewRequest = z.infer<typeof FxPreviewRequestSchema>

export type FxPreviewResponse =
  | { degenerate: true; tripCurrency: string }
  | { degenerate: false; tripCurrency: string; rateDecimal: string; rateDate: string }

export async function fxPreview(
  uid:                string,
  req:                FxPreviewRequest,
  serviceAccountJson: string,
): Promise<FxPreviewResponse> {
  const { tripFields } = await readTripAccess(serviceAccountJson, req.tripId, uid)

  const tripCurrency = readString(tripFields, 'currency')
  if (!tripCurrency) throw new CascadeError(500, 'trip.currency is missing')

  const resolved = await resolveFxRate(
    { requestedDate: req.requestedDate, sourceCurrency: req.sourceCurrency, tripCurrency },
    serviceAccountJson,
  )
  if (!resolved) return { degenerate: true, tripCurrency }
  return { degenerate: false, tripCurrency, rateDecimal: resolved.rateDecimal, rateDate: resolved.rateDate }
}
