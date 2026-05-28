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
// Algorithm ownership after Phase 4: steps 3-4 (remaining + normalize)
// delegate to `@tripmate/settlement-core`. This file and the Worker's
// settlement create-gate (workers/ocr/src/settlement-write.ts) both
// import the same `computePairwiseRemaining` — no more mirrored impl,
// no more dual-side cross-check fixture suite. The canonical 8
// fixtures live in `packages/settlement-core/src/index.test.ts`.
//
// Steps 1-2 stay here because orphan extraction needs per-settlement
// leftover (which the core function deliberately doesn't surface;
// that's a UI concern). Step 5 + paid/owed display + ghost rows +
// chronological orphan-reason replay are all UI-only and stay
// client-side.
//
// "Ghost participant" 設計:當 expense 的 paidBy 或 splits.memberId
// 不在當前 members 列表(被踢、自願退出、未結算離開),我們仍要把這
// 筆 uid 納入計算,否則 sum(net) 不平衡,UI 會顯示「四個人共欠 800
// 沒人收」這種帳對不起來的怪畫面。`isGhost: true` 旗標讓 UI 標示
// 「退出済み」灰色 chip。
import {
  SETTLEMENT_EPS,
  computePairwiseRemaining,
  type CoreSettlement,
} from '@tripmate/settlement-core'
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
 *                     on this pair (gross == 0). Defensive should-
 *                     never-happen guard: with `allow delete: if false`
 *                     on expenses and the Worker trip-cascade deleting
 *                     settlements alongside their expenses, there's
 *                     no remaining path that produces this state for
 *                     data-at-rest. Kept as a catch-all so future
 *                     unexpected admin writes / data corruption surface
 *                     visibly instead of silently masquerading as a
 *                     different reason.
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
  /** Step-4 normalized remaining debt edges: `pairwise[from][to] = amount`
   *  represents real outstanding pair debt after settlement application
   *  and opposite-direction cancellation. Consumed by `computeSettlements`
   *  to produce suggestion list; surfaced so callers re-use the same
   *  edges the algorithm internally derived. Worker validation reads the
   *  same edges to gate `amount <= remaining` — passing the same shape
   *  out (instead of recomputing pair-wise elsewhere) keeps UI suggestion
   *  / Worker reject semantics in lockstep. */
  pairwise: Record<string, Record<string, number>>
}

/** Lazy-create `record[key]` as an empty sub-map and return it for
 *  in-place writes. Replaces the repeated `record[k] ?? (record[k] = {})`
 *  fallback-assign idiom across the pairwise maps (gross/applied) and
 *  the chronological replay's intermediate state in
 *  `buildOrphanReasonMap`. Not exported from @tripmate/settlement-core
 *  because it's a 4-line generic helper, not a domain primitive. */
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

// ─── Input self-defense ─────────────────────────────────────────────

/**
 * Sanity check: an expense is safe to feed into the debt-edge math
 * iff every numeric input is finite + non-negative, and every uid is
 * a non-empty string. The Worker validation layer enforces all this
 * on write, but the settlement engine is downstream of a separate
 * trust boundary -- a future Worker bug, a manual Firestore Console
 * edit, or a doc that predates the Worker chokepoint could otherwise
 * inject NaN/Infinity into the gross[][] tables and propagate
 * "NaN ¥" through the entire settlement UI.
 *
 * Mirrors the silent filter inside `computePairwiseRemaining` in
 * @tripmate/settlement-core; kept local so we can attach a console.warn
 * with the offending doc id, which the core can't do (Worker has no
 * console). Identical predicates → identical accept/reject decisions
 * on both sides of the trust boundary.
 */
function isExpenseSettlementSafe(e: Expense): boolean {
  if (!Number.isFinite(e.amount) || e.amount < 0) return false
  if (typeof e.paidBy !== 'string' || e.paidBy === '') return false
  if (!Array.isArray(e.splits)) return false
  for (const s of e.splits) {
    if (typeof s.memberId !== 'string' || s.memberId === '') return false
    if (!Number.isFinite(s.amount) || s.amount < 0) return false
  }
  return true
}

/** Same trust-boundary check as core's `isSettlementSafe`, but bound
 *  to the rich SettlementRecord shape so the filter callsite can
 *  console.warn the offending `s.id`. Predicates intentionally
 *  identical to the core; the only difference is the input type. */
function isSettlementSafe(s: SettlementRecord): boolean {
  if (!Number.isFinite(s.amount) || s.amount <= 0) return false
  if (typeof s.fromUid !== 'string' || s.fromUid === '') return false
  if (typeof s.toUid   !== 'string' || s.toUid   === '') return false
  if (s.fromUid === s.toUid) return false
  return true
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
  expensesRaw: Expense[],
  members:     TripMember[],
  settlementsRaw: SettlementRecord[] = [],
): BalanceResult {
  // Filter out malformed docs at the trust boundary. Worker write-path
  // validation prevents these in normal flow, but a doc from before
  // the Worker chokepoint, a manual Console edit, or a future Worker
  // bug could otherwise inject NaN/Infinity that would propagate
  // "NaN ¥" through every settlement card. Skipping them keeps the
  // UI honest about active expenses; the dirty docs are visible in
  // the list (with their own validation messaging) but stay out of
  // the math.
  const expenses    = expensesRaw.filter(e => {
    if (isExpenseSettlementSafe(e)) return true
    console.warn(`[settlement] excluding malformed expense ${e.id}`, e)
    return false
  })
  const settlements = settlementsRaw.filter(s => {
    if (isSettlementSafe(s)) return true
    console.warn(`[settlement] excluding malformed settlement ${s.id}`, s)
    return false
  })

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
    if (leftover > SETTLEMENT_EPS) {
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

  // Steps 3-4 (remaining + normalize) delegate to @tripmate/settlement-
  // core so this file and the Worker's create-gate share one canonical
  // pairwise impl. Core re-filters + re-sorts internally so the call is
  // self-contained; we pass `activeExpenses` (Expense is a structural
  // superset of CoreExpense — amount/paidBy/splits all line up) and
  // adapt SettlementRecord → CoreSettlement by flattening createdAt to
  // an epoch-ms number. Core does NOT return per-settlement leftover,
  // which is why steps 1-2 above stay here for orphan extraction.
  const normalized = computePairwiseRemaining(
    activeExpenses,
    settlements.map<CoreSettlement>(s => ({
      fromUid:     s.fromUid,
      toUid:       s.toUid,
      amount:      s.amount,
      createdAtMs: s.createdAt?.toMillis?.() ?? 0,
    })),
  )

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
  return { balances, orphans, participants, pairwise: normalized }
}

/**
 * Per-settlement state captured at its recording time by the
 * chronological replay. Combined with the FINAL leftover (computed
 * by the main forward-cap loop) to derive each orphan's `reason`.
 *
 *   atRecording      'NO_EXPENSE' | 'WITHIN' | 'OVER'
 *                    NO_EXPENSE — no expense on this pair at recording
 *                                 (defensive should-never-happen guard;
 *                                 see OrphanReason: UNKNOWN doc)
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
    if (grossT < SETTLEMENT_EPS) {
      atRecording = 'NO_EXPENSE'
    } else if (st.amount - availableT > SETTLEMENT_EPS) {
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
 * overpayment by more than SETTLEMENT_EPS -- the excess can only come
 * from a subsequent delete shrinking the gross that the settlement was
 * actively consuming.
 */
function classifyOrphan(info: SettlementReplayInfo | undefined, leftover: number): OrphanReason {
  if (!info || info.atRecording === 'NO_EXPENSE')        return 'UNKNOWN'
  if (info.atRecording === 'WITHIN')                     return 'EXPENSE_DELETED'
  // atRecording === 'OVER'
  if (leftover - info.overpayment > SETTLEMENT_EPS)      return 'MIXED'
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
 * 把 normalized remaining debt edges 平鋪成 settlement suggestion list。
 *
 * 每條 `pairwise[from][to] > 0` 邊各自產生一筆建議,**不做 multi-hop
 * 收斂**。A→B=10、B→C=10 會建議兩筆(不會合成 A→C)。
 *
 * `pair-based suggestions intentionally prioritize Worker-verifiable
 * semantics over minimum-transfer optimization`:
 *   - UI 顯示的每一筆建議,Worker 寫入時都對得到一條真實的 pair debt
 *     edge,`amount <= remaining[from][to]` 一定成立,絕無「UI 建議的
 *     金額被 Worker 拒」的 drift。
 *   - 代價是某些長鏈情境會多列幾筆(例 3-人非平衡 cycle A→B=10、
 *     B→C=10、C→A=10:這版產 3 筆,舊版 net-greedy 產 0 筆)。對使用
 *     者來說每筆都連得到具體 expense,可審計性 > 條數最小化。
 *
 * 排序:by from then to,讓輸出在跨 reload / 跨 trip 之間穩定。
 */
export function computeSettlements(
  pairwise: Record<string, Record<string, number>>,
): Settlement[] {
  const out: Settlement[] = []
  for (const from of Object.keys(pairwise).sort()) {
    const row = pairwise[from]!
    for (const to of Object.keys(row).sort()) {
      const amount = row[to] ?? 0
      if (amount > SETTLEMENT_EPS) {
        out.push({ fromId: from, toId: to, amount: Math.round(amount) })
      }
    }
  }
  return out
}
