// src/features/trips/types.ts
// Demo-mode trip shape (`TripItem`) + member chip type — distinct from the
// Firestore `Trip` in `@/types` which uses Timestamp dates and
// `destination` (vs `dest`) / `icon` (vs `emoji`). Pages that handle both
// modes branch on isDemo and convert via cloudTripToItem.
export interface TripMember {
  id:    string
  label: string   // 單字頭像文字，如 '我'、'友'
  color: string   // 文字色
  bg:    string   // 底色
  /**
   * True when this uid only appears in expense history (paidBy / splits)
   * but is no longer a trip member — kicked out, left, or removed before
   * settling. Surfaces in UI as a "(退出済み)" label so settlement stays
   * reconcilable without confusing readers. Active members leave this
   * undefined.
   */
  isGhost?: boolean
}

export interface TripItem {
  id:        string
  title:     string
  dest:      string
  emoji:     string
  startDate: string
  endDate:   string
  members:   TripMember[]
  /**
   * True when the signed-in user is the trip owner. Drives per-trip UI
   * gating in TripSwitcher (delete swipe + tap on rows that aren't
   * mine should be disabled — only the owner can delete a trip per
   * firestore.rules `isTripOwner`). Demo mode has no real ownership
   * concept, so demo trips set this to true unconditionally.
   */
  ownedByMe: boolean
}

export type MenuActionKey = 'edit' | 'members' | 'copy' | 'share' | 'settings'
