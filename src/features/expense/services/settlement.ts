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
 * Reason this settlement is orphan. Classified by chronological replay
 * over expense create/delete events plus settlements (phase-2 work).
 *
 *   OVERPAYMENT     — at settlement.createdAt, the settlement amount
 *                     already exceeded available debt. Pure case: the
 *                     full leftover was excess from day one.
 *   EXPENSE_DELETED — at settlement.createdAt, the settlement fit
 *                     within available debt. Pure case: orphan exists
 *                     entirely because a subsequent soft-delete
 *                     reduced gross after the fact.
 *   MIXED           — settlement was partly over at recording AND a
 *                     subsequent delete shrunk what was within. Both
 *                     causes contribute to the leftover; the per-row
 *                     amount can't be cleanly attributed to one.
 *   UNKNOWN         — at settlement.createdAt, no expense was recorded
 *                     on this pair (gross == 0). Could be true
 *                     overpayment OR a legacy hard-deleted expense
 *                     pre-phase-2. We can't distinguish.
 */
export type OrphanReason = 'OVERPAYMENT' | 'EXPENSE_DELETED' | 'MIXED' | 'UNKNOWN'

/**
 * 一筆 settlement 中無法對應到既存債務的剩餘金額。
 *
 * 每一筆 leftover > 0 的 settlement 各自獨立一個 entry,並夾帶
 * `settlementId` 讓 UI 能精準指向「就是這筆要刪」。`reason` 由
 * `computeBalancesFull` 透過 chronological replay 推算出來 — 詳
 * `OrphanReason`。
 *
 * 順序穩定性:settlements 在算法內**按 `createdAt` 排序後處理**,所以
 * 早的先消化 gross、晚的承擔 leftover。沒這層排序的話,Firestore
 * 回傳順序左右歸因,跨頁 reload 結果會跳。
 */
export interface OrphanSettlement {
  fromUserId:   string
  toUserId:     string
  /** 這筆 settlement 自己的 leftover(非 pair 累積)。 */
  amount:       number
  /** 對應的 SettlementRecord.id,UI 用來一鍵刪除這筆 orphan。 */
  settlementId: string
  /** Why this settlement is orphan -- drives the reason-specific
   *  warning banner in SettlementSummary. */
  reason:       OrphanReason
}

export interface BalanceResult {
  balances: MemberBalance[]
  orphans:  OrphanSettlement[]
  /** Active members + any ghosts surfaced during expansion. Same order
   *  as `balances`. Returned so callers don't need a separate
   *  `expandWithGhosts` pass over the same expenses/settlements. */
  participants: TripMember[]
}

const EPS = 0.5

/** Lazy-create `record[key]` as an empty sub-map and return it for
 *  in-place writes. Replaces the repeated `record[k] ?? (record[k] = {})`
 *  fallback-assign idiom across the 4 pairwise maps below
 *  (gross/applied/orphanByPair/remaining/normalized). */
function ensureSlot<T>(
  record: Record<string, Record<string, T>>,
  key:    string,
): Record<string, T> {
  return record[key] ?? (record[key] = {})
}

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
  // order 維護全參與者 ID(active 先、ghost 按首見順序在後);ghosts 同
  // 步累積 TripMember 物件,讓回傳的 participants 一次走完免重複 walk。
  const order: string[] = members.map(m => m.id)
  const known = new Set(order)
  const ghosts: TripMember[] = []
  const ensure = (id: string) => {
    if (known.has(id)) return
    known.add(id)
    order.push(id)
    ghosts.push(ghostMember(id))
  }

  // 立替 = 你代墊給整組的金額;分擔 = 你的那份。Settlement 是 payment
  // layer,不該污染這兩個語義(否則「立替」會把還的錢也算進去)。
  const paid: Record<string, number> = {}
  const owed: Record<string, number> = {}

  // gross[from][to] = 來自 expenses 的天然債務,from 欠 to。
  const gross: Record<string, Record<string, number>> = {}
  const addGross = (from: string, to: string, amount: number) => {
    if (from === to) return
    ensure(from); ensure(to)
    const slot = ensureSlot(gross, from)
    slot[to] = (slot[to] ?? 0) + amount
  }

  // Soft-deleted expenses are excluded from paid / owed / gross --
  // they no longer represent live debt. They ARE kept for the
  // chronological replay below (buildOrphanReasonMap) which needs
  // their createdAt + deletedAt timeline to classify orphan reasons.
  const activeExpenses = expenses.filter(e => !e.deletedAt)

  // Step 1: gross debt + paid/owed display (active expenses only)
  for (const e of activeExpenses) {
    ensure(e.paidBy)
    paid[e.paidBy] = (paid[e.paidBy] ?? 0) + e.amount
    for (const s of e.splits) {
      ensure(s.memberId)
      owed[s.memberId] = (owed[s.memberId] ?? 0) + s.amount
      addGross(s.memberId, e.paidBy, s.amount)
    }
  }

  // Step 2: settlements cap at gross per pair. 核心不變式:applied ≤ gross。
  // 超額部分變 orphan,不影響 balance — 只供上層 UI 提示使用者。
  //
  // 處理順序: 按 createdAt 排序後再 fold。讓「早的 settlement 先消化
  // 可用 gross,晚的承擔 leftover」變成確定性結果。原本走 Firestore
  // 回傳順序(實質非確定性),per-settlement orphan 歸因會在不同 reload
  // 之間跳。stable sort:同 ts 的 settlements 維持原 array 順序。
  const sortedSettlements = [...settlements].sort((a, b) => {
    const aMs = a.createdAt?.toMillis?.() ?? 0
    const bMs = b.createdAt?.toMillis?.() ?? 0
    return aMs - bMs
  })

  // Pre-compute per-settlement at-recording state via chronological
  // replay BEFORE the forward-cap loop. Replay answers "what was the
  // available debt at this settlement's recording time, and by how
  // much (if any) did the settlement exceed it then?". Forward-cap
  // (below) answers "what's the leftover at the current state?".
  // `classifyOrphan` combines both to decide reason -- including MIXED
  // when leftover exceeds recording-time overpayment, meaning both
  // causes contributed.
  const replayById = buildOrphanReasonMap(expenses, sortedSettlements)

  const applied: Record<string, Record<string, number>> = {}
  const orphans: OrphanSettlement[] = []

  for (const st of sortedSettlements) {
    if (st.fromUid === st.toUid) continue
    ensure(st.fromUid); ensure(st.toUid)
    const debt = gross[st.fromUid]?.[st.toUid] ?? 0
    const appliedSlot = ensureSlot(applied, st.fromUid)
    const already = appliedSlot[st.toUid] ?? 0
    const usable = Math.min(st.amount, Math.max(0, debt - already))
    appliedSlot[st.toUid] = already + usable
    const leftover = st.amount - usable
    if (leftover > EPS) {
      // Per-settlement entry instead of per-pair sum so UI can target
      // the exact unmatched record for one-tap delete. Multiple entries
      // can share a (fromUserId, toUserId) pair if several settlements
      // on that pair have leftover.
      orphans.push({
        fromUserId:   st.fromUid,
        toUserId:     st.toUid,
        amount:       leftover,
        settlementId: st.id,
        reason:       classifyOrphan(replayById.get(st.id), leftover),
      })
    }
  }

  // Step 3: remaining = max(0, gross - applied)
  const remaining: Record<string, Record<string, number>> = {}
  for (const from of Object.keys(gross)) {
    const grossRow = gross[from]!
    for (const to of Object.keys(grossRow)) {
      const rest = Math.max(0, (grossRow[to] ?? 0) - (applied[from]?.[to] ?? 0))
      if (rest > EPS) ensureSlot(remaining, from)[to] = rest
    }
  }

  // Step 4: normalize. 對每組無序 pair 把對抵的反方向邊合併成淨額。
  // 例:A→B=30、B→A=50  →  B→A=20。對 net 沒影響(net 不看方向只看
  // 邊權),但任何用 pairwise edge 的 UI 都會更乾淨。
  const normalized: Record<string, Record<string, number>> = {}
  const seenPair = new Set<string>()

  for (const from of Object.keys(remaining)) {
    for (const to of Object.keys(remaining[from]!)) {
      const key = from < to ? `${from}|${to}` : `${to}|${from}`
      if (seenPair.has(key)) continue
      seenPair.add(key)

      const fwd = remaining[from]?.[to] ?? 0
      const bwd = remaining[to]?.[from] ?? 0
      if (fwd - bwd > EPS) ensureSlot(normalized, from)[to] = fwd - bwd
      else if (bwd - fwd > EPS) ensureSlot(normalized, to)[from] = bwd - fwd
      // |fwd - bwd| ≤ EPS → 完全抵銷,無 edge
    }
  }

  // Step 5: net[i] = Σ normalized[j][i] − Σ normalized[i][j]
  const net: Record<string, number> = {}
  for (const id of order) net[id] = 0
  for (const from of Object.keys(normalized)) {
    const row = normalized[from]!
    for (const to of Object.keys(row)) {
      const amount = row[to] ?? 0
      net[from] = (net[from] ?? 0) - amount
      net[to]   = (net[to]   ?? 0) + amount
    }
  }

  const balances = order.map<MemberBalance>(id => ({
    memberId: id,
    paid: paid[id] ?? 0,
    owed: owed[id] ?? 0,
    net:  net[id]  ?? 0,
  }))

  const participants = ghosts.length === 0 ? members : [...members, ...ghosts]
  return { balances, orphans, participants }
}

/**
 * Per-settlement state captured at its recording time by the
 * chronological replay. Combined with the FINAL leftover (computed
 * by the main forward-cap loop) to derive each orphan's `reason`.
 *
 *   atRecording      'NO_EXPENSE' | 'WITHIN' | 'OVER'
 *                    NO_EXPENSE — no expense on this pair at recording
 *                                 (legacy hard-delete OR true never-existed)
 *                    WITHIN     — settlement fit available debt at recording
 *                    OVER       — settlement exceeded available debt
 *   overpayment      amount that exceeded available at recording (≥0).
 *                    0 when atRecording != 'OVER'.
 */
interface SettlementReplayInfo {
  atRecording: 'NO_EXPENSE' | 'WITHIN' | 'OVER'
  overpayment: number
}

/**
 * Chronological replay over (expense create/delete + settlement) events.
 * Returns per-settlement replay state used by the main loop to classify
 * each orphan reason -- including MIXED, when both at-recording
 * overpayment AND a subsequent soft-delete contributed to the leftover.
 *
 * Within the same timestamp: expense_create < expense_delete <
 * settlement, so a settlement recorded at the same ms as an expense
 * create sees the expense as already-applied.
 */
function buildOrphanReasonMap(
  expenses:    Expense[],
  settlements: SettlementRecord[],
): Map<string, SettlementReplayInfo> {
  type Event =
    | { type: 'expense_create'; ts: number; expense: Expense }
    | { type: 'expense_delete'; ts: number; expense: Expense }
    | { type: 'settlement';     ts: number; settlement: SettlementRecord }

  const events: Event[] = []
  for (const e of expenses) {
    const cMs = e.createdAt?.toMillis?.() ?? 0
    events.push({ type: 'expense_create', ts: cMs, expense: e })
    if (e.deletedAt) {
      const dMs = e.deletedAt.toMillis?.() ?? 0
      events.push({ type: 'expense_delete', ts: dMs, expense: e })
    }
  }
  for (const st of settlements) {
    const stMs = st.createdAt?.toMillis?.() ?? 0
    events.push({ type: 'settlement', ts: stMs, settlement: st })
  }
  const TYPE_ORDER: Record<Event['type'], number> = {
    expense_create: 0, expense_delete: 1, settlement: 2,
  }
  events.sort((a, b) => a.ts - b.ts || TYPE_ORDER[a.type] - TYPE_ORDER[b.type])

  const pairGrossT:   Record<string, Record<string, number>> = {}
  const pairAppliedT: Record<string, Record<string, number>> = {}
  const out = new Map<string, SettlementReplayInfo>()

  for (const ev of events) {
    if (ev.type === 'expense_create' || ev.type === 'expense_delete') {
      const e    = ev.expense
      const sign = ev.type === 'expense_create' ? +1 : -1
      for (const split of e.splits) {
        if (split.memberId === e.paidBy) continue
        const slot = ensureSlot(pairGrossT, split.memberId)
        slot[e.paidBy] = (slot[e.paidBy] ?? 0) + sign * split.amount
      }
      continue
    }
    const st = ev.settlement
    if (st.fromUid === st.toUid) continue
    const grossT     = pairGrossT[st.fromUid]?.[st.toUid] ?? 0
    const appliedT   = pairAppliedT[st.fromUid]?.[st.toUid] ?? 0
    const availableT = Math.max(0, grossT - appliedT)
    const usableT    = Math.min(st.amount, availableT)
    ensureSlot(pairAppliedT, st.fromUid)[st.toUid] = appliedT + usableT

    let atRecording: SettlementReplayInfo['atRecording']
    let overpayment = 0
    if (grossT < EPS) {
      atRecording = 'NO_EXPENSE'
    } else if (st.amount - availableT > EPS) {
      atRecording = 'OVER'
      overpayment = st.amount - availableT
    } else {
      atRecording = 'WITHIN'
    }
    out.set(st.id, { atRecording, overpayment })
  }
  return out
}

/**
 * Derive the orphan reason from at-recording state + final leftover.
 * The mixed case (partly OVER at recording, partly EXPENSE_DELETED
 * later) is detected when leftover EXCEEDS the recording-time
 * overpayment by more than EPS -- the excess can only come from a
 * subsequent delete shrinking the gross that the settlement was
 * actively consuming.
 */
function classifyOrphan(info: SettlementReplayInfo | undefined, leftover: number): OrphanReason {
  if (!info || info.atRecording === 'NO_EXPENSE') return 'UNKNOWN'
  if (info.atRecording === 'WITHIN')              return 'EXPENSE_DELETED'
  // atRecording === 'OVER'
  if (leftover - info.overpayment > EPS)          return 'MIXED'
  return 'OVERPAYMENT'
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
  // Single partition pass — was two `.filter().map()` chains that walked
  // `balances` twice. N≤10 in practice so the speedup is unmeasurable,
  // but the rewrite reads as one intent (split into +/− buckets) rather
  // than two near-duplicate stanzas.
  const creditors: { id: string; amt: number }[] = []
  const debtors:   { id: string; amt: number }[] = []
  for (const b of balances) {
    if      (b.net >  EPS) creditors.push({ id: b.memberId, amt:  b.net })
    else if (b.net < -EPS) debtors.push  ({ id: b.memberId, amt: -b.net })
  }
  creditors.sort((a, b) => b.amt - a.amt)
  debtors.sort  ((a, b) => b.amt - a.amt)

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
