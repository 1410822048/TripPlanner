// ─── OCR / PDF-extract trip gate ─────────────────────────────────────
//
// /ocr and /booking-pdf-extract spend paid model quota, so
// they are not open to any signed-in Google account. The UI only offers
// them inside the expense / booking editors, which are owner/editor-only,
// so the gate mirrors that. `tripId` is a required request field (the
// request schemas reject a body without it).

import { readTripAccess }              from './membership-shared'

/** Refuse unless `uid` is an active owner/editor of `tripId`. Same order
 *  as the other endpoints: 404 → 410 → 403 non-member → 403 removing →
 *  403 role. */
export async function assertOcrTripAccess(
  serviceAccountJson: string,
  tripId:             string,
  uid:                string,
): Promise<void> {
  await readTripAccess(serviceAccountJson, tripId, uid, { roles: ['owner', 'editor'] })
}
