// src/features/expense/services/settlement.ts
// 精算算法 — 純函式,無 side effect。
//
// ┌─────────────────────────────────────────────────────────────────┐
// │ Debt-edge accounting model                                       │
// │                                                                  │
// │ 核心不變式: settlement 只能 REDUCE debt,不能 CREATE debt。      │
// │                                                                  │
// │ 1. expenses → gross[from][to] 配對債務圖                          │
// │ 2. settlements 按 pair cap 在 gross 上 → 超出視為 orphan          │
// │ 3. remaining = max(0, gross - applied)                           │
// │ 4. normalize: 對向邊抵銷,只留淨額方向                              │
// │ 5. net per person 從 normalized remaining 算                      │
// │                                                                  │
// │ 為什麼 person-centric 模型錯了:                                   │
// │   舊算法把 settlement 當 reverse expense (paid+=、owed+=),於是   │
// │   刪除 expense 後 settlement 還在 → 反方向債從天上掉下來。        │
// │   debt-edge 模型則保證 settlement 只能 consume 既存債務,沒對應    │
// │   的部分變成 orphan 顯式追蹤,UI 可以提示「未紐づけ」讓使用者     │
// │   決定刪不刪。                                                   │
// └─────────────────────────────────────────────────────────────────┘
//
// "Ghost participant" 設計:當 expense 的 paidBy 或 splits.memberId
// 不在當前 members 列表(被踢、自願退出、未結算離開),我們仍要把這
// 筆 uid 納入計算,否則 sum(net) 不平衡,UI 會顯示「四個人共欠 800
// 沒人收」這種帳對不起來的怪畫面。`isGhost: true` 旗標讓 UI 標示
// 「退出済み」灰色 chip。
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import type { TripMember } from '@/features/trips/types'

export interface MemberBalance {
  memberId: string
  /** 這個人代墊的總額(只看 expenses,不含 settlements)。 */
  paid: number
  /** 這個人應該分攤的總額(只看 expenses,不含 settlements)。 */
  owed: number
  /** Settlement + normalize 之後的淨額。正值 = 應收、負值 = 應付。 */
  net: number
}

export interface Settlement {
  fromId: string  // 付款人(應付)
  toId:   string  // 收款人(應收)
  amount: number
}

/**
 * 一筆 settlement 中無法對應到既存債務的金額。
 * 兩種來源:
 *   1. settlement 金額超過該 pair 的天然債務(overpayment)
 *   2. 對應的 expense 已被刪除(expense deleted after settlement)
 * 兩者事後看起來一樣 —— 都是 settled > gross。Phase 2 可加 chronological
 * replay 區分原因,目前只追蹤金額。
 */
export interface OrphanSettlement {
  fromUserId: string
  toUserId:   string
  /** 累積該 pair 上所有 unmatched 金額。 */
  amount: number
}

export interface BalanceResult {
  balances: MemberBalance[]
  orphans:  OrphanSettlement[]
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
 * Append ghost TripMembers for any uid mentioned in `expenses` /
 * `settlements`(as paidBy / split.memberId / fromUid / toUid)but not
 * in `members`. The returned list preserves active-first order, with
 * ghosts deduped at the tail.
 */
export function expandWithGhosts(
  members:     TripMember[],
  expenses:    Expense[],
  settlements: SettlementRecord[] = [],
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
  for (const s of settlements) {
    ensure(s.fromUid)
    ensure(s.toUid)
  }
  return ghosts.length === 0 ? members : [...members, ...ghosts]
}

// ─── Debt-edge model: 主算法 ───────────────────────────────────────

/**
 * 計算每位成員的 paid / owed / net 加 orphan settlement 列表。
 *
 * paid / owed 僅來自 expenses(代墊與分擔的純語意,不污染);net 來自
 * settlement-cap-and-normalize 後的剩餘 debt。
 *
 * 對 expense / settlement 中出現但不在 `members` 的 uid,自動 append
 * 為 ghost row,確保 sum(net) ≈ 0、settlement 配對能找到所有參與者。
 *
 * 演算法時間複雜度: O(E·S + Σ + N²);S = avg splits/expense、Σ = settlement
 * 數、N = 成員數。對 trip-scale (E ≤ 200, S ≤ 6, N ≤ 8) 完全無感。
 */
export function computeBalancesFull(
  expenses:    Expense[],
  members:     TripMember[],
  settlements: SettlementRecord[] = [],
): BalanceResult {
  // 維護展開後的順序列表:active 先、ghost 後(按 expense/settlement
  // 中首次出現為準),確保 output 順序可預測。
  const order: string[] = members.map(m => m.id)
  const known = new Set(order)
  const ensure = (id: string) => {
    if (!known.has(id)) {
      known.add(id)
      order.push(id)
    }
  }

  // Display accumulators — expenses only, never settlements.
  // 立替 = 你代墊給整組的金額;分擔 = 你的那份。Settlement 是 payment
  // layer,不該污染這兩個語義(否則「立替」會把你還的錢也算進去)。
  const paid: Record<string, number> = {}
  const owed: Record<string, number> = {}

  // gross[from][to] = 來自 expenses 的天然債務,from 欠 to。
  const gross: Record<string, Record<string, number>> = {}
  const addGross = (from: string, to: string, amount: number) => {
    if (from === to) return  // 自己分擔自己付的不算 debt
    ensure(from); ensure(to)
    gross[from] ??= {}
    gross[from][to] = (gross[from][to] ?? 0) + amount
  }

  // ── Step 1: 由 expenses 建 gross debt + paid/owed display ──────
  for (const e of expenses) {
    ensure(e.paidBy)
    paid[e.paidBy] = (paid[e.paidBy] ?? 0) + e.amount
    for (const s of e.splits) {
      ensure(s.memberId)
      owed[s.memberId] = (owed[s.memberId] ?? 0) + s.amount
      addGross(s.memberId, e.paidBy, s.amount)
    }
  }

  // ── Step 2: 套用 settlements,cap 在每個 pair 的 gross debt ────
  // 核心不變式:applied[from][to] ≤ gross[from][to]。超出的部分變成
  // orphan,完全不影響 balance,只交給上層 UI 提示使用者。
  const applied: Record<string, Record<string, number>> = {}
  const orphanByPair: Record<string, Record<string, number>> = {}

  for (const st of settlements) {
    if (st.fromUid === st.toUid) continue  // 自我 settlement (應該不存在,但 defensive)
    ensure(st.fromUid); ensure(st.toUid)
    const debt = gross[st.fromUid]?.[st.toUid] ?? 0
    // Capture slot via fallback-assign so TS narrows it to non-undefined
    // for the subsequent indexed writes — `??=` doesn't propagate the
    // narrowing in current TS strict mode.
    const appliedSlot = applied[st.fromUid] ?? (applied[st.fromUid] = {})
    const already = appliedSlot[st.toUid] ?? 0
    const room = Math.max(0, debt - already)
    const usable = Math.min(st.amount, room)
    appliedSlot[st.toUid] = already + usable
    const leftover = st.amount - usable
    if (leftover > 0) {
      const orphanSlot = orphanByPair[st.fromUid] ?? (orphanByPair[st.fromUid] = {})
      orphanSlot[st.toUid] = (orphanSlot[st.toUid] ?? 0) + leftover
    }
  }

  // ── Step 3: remaining = max(0, gross - applied) ────────────────
  const remaining: Record<string, Record<string, number>> = {}
  for (const from of Object.keys(gross)) {
    for (const to of Object.keys(gross[from] ?? {})) {
      const debt    = gross[from]?.[to] ?? 0
      const settled = applied[from]?.[to] ?? 0
      const rest    = Math.max(0, debt - settled)
      if (rest > EPS) {
        remaining[from] ??= {}
        remaining[from][to] = rest
      }
    }
  }

  // ── Step 4: Normalize cross-debt ──────────────────────────────
  // 對每一組無序 pair (a, b),把 remaining[a][b] 跟 remaining[b][a]
  // 對抵,只留淨額方向。例如:
  //   A→B = 30、B→A = 50  →  normalize 後  B→A = 20
  // 對 settlement suggestion 無影響(computeSettlements 走 net),但是
  // 對任何用 pairwise edge 的 UI(未來「兩兩明細」)或 transfer route
  // 直接顯示都會變乾淨。
  const normalized: Record<string, Record<string, number>> = {}
  const seenPair = new Set<string>()
  const allFroms = new Set<string>([...Object.keys(remaining)])

  for (const from of allFroms) {
    for (const to of Object.keys(remaining[from] ?? {})) {
      const key = from < to ? `${from}|${to}` : `${to}|${from}`
      if (seenPair.has(key)) continue
      seenPair.add(key)

      const fwd = remaining[from]?.[to] ?? 0
      const bwd = remaining[to]?.[from] ?? 0

      if (fwd - bwd > EPS) {
        normalized[from] ??= {}
        normalized[from][to] = fwd - bwd
      } else if (bwd - fwd > EPS) {
        normalized[to] ??= {}
        normalized[to][from] = bwd - fwd
      }
      // |fwd - bwd| ≤ EPS  →  完全抵銷,無 edge
    }
  }

  // ── Step 5: net per person 從 normalized remaining 算 ──────────
  // net[i] = Σ_j normalized[j][i] (others owe me)  −  Σ_j normalized[i][j] (I owe others)
  const net: Record<string, number> = {}
  for (const id of order) net[id] = 0
  for (const from of Object.keys(normalized)) {
    const row = normalized[from]
    if (!row) continue
    for (const to of Object.keys(row)) {
      const amount = row[to] ?? 0
      net[from] = (net[from] ?? 0) - amount
      net[to]   = (net[to]   ?? 0) + amount
    }
  }

  // ── Flatten orphan structure to array ──────────────────────────
  const orphans: OrphanSettlement[] = []
  for (const from of Object.keys(orphanByPair)) {
    for (const to of Object.keys(orphanByPair[from] ?? {})) {
      const amount = orphanByPair[from]?.[to] ?? 0
      if (amount > EPS) {
        orphans.push({ fromUserId: from, toUserId: to, amount })
      }
    }
  }

  const balances = order.map<MemberBalance>(id => ({
    memberId: id,
    paid: paid[id] ?? 0,
    owed: owed[id] ?? 0,
    net:  net[id]  ?? 0,
  }))

  return { balances, orphans }
}

/**
 * 簡化的 API:只回 balances。內部呼叫 computeBalancesFull,丟掉 orphans。
 * 需要 orphan 資訊的(SettlementSummary)請直接用 computeBalancesFull。
 */
export function computeBalances(
  expenses:    Expense[],
  members:     TripMember[],
  settlements: SettlementRecord[] = [],
): MemberBalance[] {
  return computeBalancesFull(expenses, members, settlements).balances
}

/**
 * 貪心算法 — 每一步把「最大應收」與「最大應付」配對。
 * 結果最多 N-1 筆(N = 有非零餘額的人數),且多數情況更少。
 * 因為走 net 不走 pairwise,自然能解 3-人 cycle 這種 normalize 解不掉
 * 的優化情況(例:A→B→C→A 各 10,net 全 0,suggestion 為空)。
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
