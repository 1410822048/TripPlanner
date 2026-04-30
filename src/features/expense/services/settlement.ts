// src/features/expense/services/settlement.ts
// 精算算法 — 純函式，無 side effect。
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

/** 計算每位成員的 paid / owed / net。結果順序 = members 順序。 */
export function computeBalances(
  expenses: Expense[],
  members:  TripMember[],
): MemberBalance[] {
  const acc: Record<string, { paid: number; owed: number }> = {}
  for (const m of members) acc[m.id] = { paid: 0, owed: 0 }

  for (const e of expenses) {
    const p = acc[e.paidBy]
    if (p) p.paid += e.amount
    for (const s of e.splits) {
      const o = acc[s.memberId]
      if (o) o.owed += s.amount
    }
  }

  return members.map(m => {
    const a = acc[m.id] ?? { paid: 0, owed: 0 }
    return { memberId: m.id, paid: a.paid, owed: a.owed, net: a.paid - a.owed }
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
