// src/features/account/hooks/useThreeHotelThumbUrls.ts
// Resolve up to 3 hotel-booking thumbnail blob URLs for the AccountPage
// lodging deck. path-only: each thumbPath is fetched via getBlob (Storage
// Rules) → objectURL. Hooks can't be called in a loop, so we resolve a
// FIXED three slots (the deck shows at most 3) and drop the nulls.
import type { Booking } from '@/types'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { attachmentThumbPath } from '@/features/bookings/utils'

export function useThreeHotelThumbUrls(bookings: Booking[] | undefined): string[] {
  // Derive the first 3 thumb PATHS, SKIPPING thumb-less bookings (PDF /
  // pre-thumb), BEFORE the hooks — so newest-three-are-PDFs doesn't hide
  // images that older bookings do have. Then resolve a fixed 3 slots (hook
  // rules forbid a variable count). Newest-first order is the caller's
  // (useMyHotelBookings returns sortDate-desc).
  const paths: (string | undefined)[] = []
  for (const b of bookings ?? []) {
    const p = attachmentThumbPath(b.coverImage)
    if (p) paths.push(p)
    if (paths.length === 3) break
  }
  const u0 = useAttachmentUrl(paths[0], { kind: 'thumb' })
  const u1 = useAttachmentUrl(paths[1], { kind: 'thumb' })
  const u2 = useAttachmentUrl(paths[2], { kind: 'thumb' })
  return [u0, u1, u2].filter((u): u is string => !!u)
}
