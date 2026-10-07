// ─── OCR / PDF-extract trip gate ─────────────────────────────────────
//
// /ocr, /ocr-fallback and /booking-pdf-extract spend paid model quota but
// used to accept any signed-in Google account: no trip, no role. The UI
// only offers them inside the expense / booking editors, which are
// owner/editor-only, so the gate mirrors that.
//
// Rollout is two-phase because `tripId` is a new request field:
//   1. Clients send `tripId`; the Worker enforces the role whenever it is
//      present and still accepts requests without it (old app versions).
//   2. Once old clients have aged out, set the `OCR_REQUIRE_TRIP_ID` var to
//      "1" and requests without a tripId are refused.

import { getAdminToken, getProjectId } from './admin'
import { getDocFields, readString }    from './firestore'
import { CascadeError }                from './cascade'
import { assertMemberNotRemoving }     from './membership-shared'

export function ocrTripIdRequired(flag: string | undefined): boolean {
  return flag === '1' || flag === 'true'
}

/** Refuse unless `uid` is an active owner/editor of `tripId`, or — during
 *  phase 1 — no tripId was sent at all. Same order as the other endpoints:
 *  404 → 410 → 403 non-member → 403 removing → 403 role. */
export async function assertOcrTripAccess(
  serviceAccountJson: string,
  tripId:             string | undefined,
  uid:                string,
  requireTripId:      boolean,
): Promise<void> {
  if (tripId === undefined) {
    if (requireTripId) throw new CascadeError(400, 'tripId is required')
    return
  }
  const accessToken = await getAdminToken(serviceAccountJson)
  const projectId   = getProjectId(serviceAccountJson)
  const [tripFields, memberFields] = await Promise.all([
    getDocFields(accessToken, projectId, `trips/${tripId}`),
    getDocFields(accessToken, projectId, `trips/${tripId}/members/${uid}`),
  ])
  if (!tripFields)                throw new CascadeError(404, 'trip not found')
  if ('deletingAt' in tripFields) throw new CascadeError(410, 'trip is being deleted')
  if (!memberFields)              throw new CascadeError(403, 'caller is not a trip member')
  assertMemberNotRemoving(memberFields)
  const role = readString(memberFields, 'role')
  if (role !== 'owner' && role !== 'editor') {
    throw new CascadeError(403, 'caller role is not owner/editor')
  }
}
