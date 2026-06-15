// src/features/wish/utils.ts
// Wish board の派生ルールを 1 か所に集約する純関数群。順位ルールと賛成度の
// 表示状態がここだけにあるので、listener postProcess / WishPage render /
// 楽観的 patch / WishCard が同じ事実を見る(votes.length desc を service・
// page・card に散らさない)。
import type { Wish } from '@/types'

// ─── Ranking ──────────────────────────────────────────────────────

/** 票数の多い順、同票は createdAt 降順(= Firestore クエリ / listener 順)。
 *
 *  Firestore は配列を要素単位(uid の辞書順)でしか並べられず length では
 *  並べられないので votes 降順はクライアントで決める。createdAt 降順を明示的な
 *  第2キーにすることで、入力の並びに依存せず常に同じ結果を返す — 楽観的投票で
 *  キャッシュ順が崩れても snapshot と同じ並びを再現でき、投票直後の rank/hero が
 *  ズレない。 */
function byVotesThenRecent(a: Wish, b: Wish): number {
  return (
    b.votes.length - a.votes.length ||
    (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
  )
}

/** Wish 配列を consensus leaderboard 順に並べ替えた新配列を返す。元配列は
 *  破壊しないので、TanStack キャッシュや MOCK 定数にそのまま当ててよい。 */
export function rankWishes(wishes: Wish[]): Wish[] {
  return [...wishes].sort(byVotesThenRecent)
}

// ─── Consensus(賛成度)────────────────────────────────────────────

/** 賛成度バーの表示状態。members query は wishes より遅れて解決し得る(cloud は
 *  wishes が先に届く)ため、メンバー数が確定しているか否かを型で区別する。
 *  ready:false の間は分母(`/0`)も percent も出さず、票数だけを見せる。 */
export type Consensus =
  | { ready: false; votes: number }
  | { ready: true; votes: number; memberCount: number; percent: number }

/** (votes, メンバー数, members ロード済みか)→ Consensus。メンバー未確定 or
 *  memberCount<=0 は ready:false。percent は 100 上限でクランプ(退会者の残票で
 *  votes>memberCount になっても bar が溢れない)。 */
export function toConsensus(
  votes:        number,
  memberCount:  number,
  membersReady: boolean,
): Consensus {
  if (!membersReady || memberCount <= 0) return { ready: false, votes }
  const percent = Math.min(100, Math.round((votes / memberCount) * 100))
  return { ready: true, votes, memberCount, percent }
}
