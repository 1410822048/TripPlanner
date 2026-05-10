// src/features/expense/services/settlement.ts
// 精算算法 — 純函式，無 side effect。
//
// "Ghost participant" 設計:當一筆 expense 的 paidBy 或 splits.memberId
// 不在當前 members 列表(他被踢、自願退出、或被移除前沒有先結算),如果
// 直接丟掉這些金額,paid 跟 owed 的總和就不平衡 — UI 顯示出來會看到
// 「四個人共欠 800,沒人收」這種帳對不起來的怪畫面。
//
// 解法:在 computeBalances 內把這些 uid 自動 append 成「ghost」row,
// 保留原本立替/分擔的金額。`isGhost: true` 旗標讓 UI 標示為「退出済み」
// 灰色 chip,既保留資訊又不混淆當前成員列表。順序固定為 active members
// 先、ghost 在後,保證輸出穩定。
//
// 這個對症修法跨層處理:邏輯層 (這裡) 保證帳一定平衡;UI 層
// (SettlementSummary) 處理 ghost 的視覺表示。
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'

export interface MemberBalance {
  memberId: string
  paid:     number  // 這個人代墊的總額
  owed:     number  // 這個人應該分攤的總額
  net:      number  // paid - owed；正值 = 應收、負值 = 應付
}

export interface Settlement {
  fromId: string  // 付款人（應付）
  toId:   string  // 收款人（應收）
  amount: number
}

const EPS = 0.5

/** Visual style for ghost participants — chip 灰色 + 「退」字。 */
const GHOST_CHIP = { label: '退', color: '#7a7a7a', bg: '#e5e5e5' } as const

/**
 * Build a placeholder TripMember for a uid that appears in expenses but
 * isn't an active member of the trip. UI uses isGhost to render the
 * 退出済み state.
 */
export function ghostMember(id: string): TripMember {
  return { id, ...GHOST_CHIP, isGhost: true }
}

/**
 * Append ghost TripMembers for any uid mentioned in `expenses` (as
 * paidBy or split.memberId) but not in `members`. The returned list
 * preserves active-first order, with ghosts deduped at the tail.
 *
 * Used by UI components that need a complete chip lookup table —
 * SettlementSummary's memberById builds off this so its `.get(id)`
 * never misses, eliminating the silent `return null` that previously
 * dropped ghost balance rows from the rendered list.
 */
export function expandWithGhosts(
  members:  TripMember[],
  expenses: Expense[],
): TripMember[] {
  const known = new Set(members.map(m => m.id))
  const ghosts: TripMember[] = []
  const seen  = new Set<string>()

  const ensure = (id: string) => {
    if (known.has(id) || seen.has(id)) return
    seen.add(id)
    ghosts.push(ghostMember(id))
  }

  for (const e of expenses) {
    ensure(e.paidBy)
    for (const s of e.splits) ensure(s.memberId)
  }
  return ghosts.length === 0 ? members : [...members, ...ghosts]
}

/**
 * 計算每位成員的 paid / owed / net。
 *
 * 對 expense 中出現但不在 `members` 的 uid,自動 append 為 ghost row
 * (順序在 active members 之後)— 保證 sum(net) ≈ 0,settlement 才能
 * 正確配對債權債務。
 *
 * 結果順序 = members 順序 + ghost 順序(以 expense 中第一次出現為準)。
 */
export function computeBalances(
  expenses: Expense[],
  members:  TripMember[],
): MemberBalance[] {
  const acc: Record<string, { paid: number; owed: number }> = {}
  // 維護一個展開後的順序列表:active 先、ghost 後(按 expense 中首次
  // 出現為準),確保結果可預測。
  const order: string[] = members.map(m => m.id)
  const known = new Set(order)

  const ensure = (id: string) => {
    if (!acc[id]) acc[id] = { paid: 0, owed: 0 }
    if (!known.has(id)) {
      known.add(id)
      order.push(id)
    }
  }

  for (const m of members) ensure(m.id)

  for (const e of expenses) {
    ensure(e.paidBy)
    acc[e.paidBy]!.paid += e.amount
    for (const s of e.splits) {
      ensure(s.memberId)
      acc[s.memberId]!.owed += s.amount
    }
  }

  return order.map(id => {
    const a = acc[id]!
    return { memberId: id, paid: a.paid, owed: a.owed, net: a.paid - a.owed }
  })
}

/**
 * 貪心算法 — 每一步把「最大應收」與「最大應付」配對。
 * 結果最多 N-1 筆（N = 有非零餘額的人數），且大多數情況會更少。
 */
export function computeSettlements(balances: MemberBalance[]): Settlement[] {
  const creditors = balances
    .filter(b => b.net > EPS)
    .map(b => ({ id: b.memberId, amt: b.net }))
    .sort((a, b) => b.amt - a.amt)

  const debtors = balances
    .filter(b => b.net < -EPS)
    .map(b => ({ id: b.memberId, amt: -b.net }))
    .sort((a, b) => b.amt - a.amt)

  const out: Settlement[] = []
  let i = 0, j = 0
  while (i < creditors.length && j < debtors.length) {
    // Loop guards prove both indices are in range.
    const c = creditors[i]!
    const d = debtors[j]!
    const transfer = Math.min(c.amt, d.amt)
    if (transfer > EPS) {
      out.push({ fromId: d.id, toId: c.id, amount: Math.round(transfer) })
    }
    c.amt -= transfer
    d.amt -= transfer
    if (c.amt < EPS) i++
    if (d.amt < EPS) j++
  }
  return out
}
