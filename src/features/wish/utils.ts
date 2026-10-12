// src/features/wish/utils.ts
// 把 Wish board 衍生規則集中在一處的純函式群。名次規則與贊成度
// 顯示狀態只存在這裡,所以 listener postProcess / WishPage render /
// 樂觀 patch / WishCard 看到的是同一份事實(不把 votes.length desc 散落在 service、
// page、card)。
import type { Wish } from '@/types'

// ─── Ranking ──────────────────────────────────────────────────────

/** 票數多者在前,同票則 createdAt 降冪(= Firestore 查詢 / listener 順序)。
 *
 *  Firestore 只能依陣列元素(uid 字典序)排序,無法依 length
 *  排序,所以 votes 降冪由 client 決定。把 createdAt 降冪明確設為
 *  第 2 鍵,就能不依賴輸入順序、永遠回傳相同結果 — 即使樂觀投票
 *  打亂了快取順序,也能重現與 snapshot 相同的排列,投票後的 rank/hero
 *  不會錯位。 */
function byVotesThenRecent(a: Wish, b: Wish): number {
  return (
    b.votes.length - a.votes.length ||
    (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
  )
}

/** 回傳依 consensus leaderboard 順序排好的 Wish 新陣列。不會破壞原陣列,
 *  所以可以直接套用在 TanStack 快取或 MOCK 常數上。 */
export function rankWishes(wishes: Wish[]): Wish[] {
  return [...wishes].sort(byVotesThenRecent)
}

// ─── Consensus(賛成度)────────────────────────────────────────────

/** 贊成度條的顯示狀態。members query 可能比 wishes 晚解析(cloud 是
 *  wishes 先到),因此用型別區分成員數是否已確定。
 *  ready:false 期間不顯示分母(`/0`)與 percent,只顯示票數。 */
export type Consensus =
  | { ready: false; votes: number }
  | { ready: true; votes: number; memberCount: number; percent: number }

/** (votes, 成員數, members 是否已載入)→ Consensus。成員未確定 或
 *  memberCount<=0 時 ready:false。percent 以 100 為上限 clamp(即使已退出者的殘留票
 *  造成 votes>memberCount,bar 也不會溢出)。 */
export function toConsensus(
  votes:        number,
  memberCount:  number,
  membersReady: boolean,
): Consensus {
  if (!membersReady || memberCount <= 0) return { ready: false, votes }
  const percent = Math.min(100, Math.round((votes / memberCount) * 100))
  return { ready: true, votes, memberCount, percent }
}
