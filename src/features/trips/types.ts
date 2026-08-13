// src/features/trips/types.ts
// Demo-mode trip shape (`TripItem`) + member chip type — distinct from the
// Firestore `Trip` in `@/types` which uses Timestamp dates and
// `destination` (vs `dest`) / `icon` (vs `emoji`). Pages that handle both
// modes branch on isDemo and convert via cloudTripToItem.
export interface TripMember {
  id: string
  /**
   * 這個人是誰 —— 身分文字、帳務畫面、ARIA 一律用這個。
   *
   * 舊版只有 `avatarLabel`(單字),導致結算、分攤、調整等記帳畫面把「陳」
   * 當成姓名在顯示,多個成員姓氏相同時根本分不出來。兩者刻意拆成不同欄位,
   * 讓編譯器擋住再次混用。
   *
   * 已退出成員由 trip doc 的 `formerMemberNames` 補;查不到才退回匿名字樣。
   */
  displayName: string
  /** 頭像色塊裡的單字素(`firstGrapheme(displayName)`)。**只給頭像用** ——
   *  永遠不要拿它當姓名顯示。 */
  avatarLabel: string
  color: string   // avatarLabel 文字色
  bg:    string   // avatarLabel 底色
  /**
   * Google 等 OAuth 來源的 profile picture URL。MemberAvatar
   * 有值就放 <img>,失敗或缺值才 fallback 成色塊+avatarLabel。從 Member doc 的
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
  /** ISO 3166-1 alpha-2 country used as the place-search fallback. */
  defaultCountryCode: string
}

export type MenuActionKey = 'edit' | 'members' | 'copy' | 'share'
