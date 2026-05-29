// src/features/trips/types.ts
// Demo-mode trip shape (`TripItem`) + member chip type — distinct from the
// Firestore `Trip` in `@/types` which uses Timestamp dates and
// `destination` (vs `dest`) / `icon` (vs `emoji`). Pages that handle both
// modes branch on isDemo and convert via cloudTripToItem.
export interface TripMember {
  id:    string
  label: string   // 單字頭像文字,如 '我'、'友'(fallback 當沒有 avatarUrl 或圖載入失敗時用)
  color: string   // label 文字色
  bg:    string   // label 底色
  /**
   * Google 等 OAuth 來源的 profile picture URL。MemberAvatar / MemberChip
   * 有值就放 <img>,失敗或缺值才 fallback 成色塊+label。從 Member doc 的
   * avatarUrl 欄位帶過來;新成員若為 Google 登入,user.photoURL 會在
   * acceptInvite 時寫進該欄位。
   */
  avatarUrl?: string
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
  /**
   * ISO 4217 currency code for all amounts on this trip (expenses,
   * estimated costs, settlement). Consumed via useTripCurrency() →
   * formatMinorAmount(); see utils/money.ts + utils/currency.ts.
   */
  currency:  string
}

export type MenuActionKey = 'edit' | 'members' | 'copy' | 'share'
