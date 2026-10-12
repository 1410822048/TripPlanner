// src/features/expense/components/SettlementSummary.tsx
import { Check, HandCoins } from 'lucide-react'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
import {
  computeBalancesFull,
  type OrphanReason,
} from '../services/settlement'
import { planRouteSuggestions, payersFor, type RouteSuggestion } from '../services/settlementRoutes'
import type { RecordIntent } from './SettlementRecordSheet'
import SettlementRouteCard from './SettlementRouteCard'
import { formatMinorAmount } from '@/utils/money'
import SettlementHistory from './SettlementHistory'

interface Props {
  expenses:    Expense[]
  members:     TripMember[]
  settlements: SettlementRecord[]
  /** uid → 離開當下的姓名。ghost 是在 computeBalancesFull 裡生出來的,
   *  所以名稱必須一路傳到那裡,否則這個畫面會顯示匿名字樣。
   *
   *  刻意「必填」而非帶預設值:漏傳不會壞畫面、只會靜靜退回匿名字樣,
   *  那種缺陷沒人會回報。讓編譯器擋住是唯一可靠的保證。 */
  formerMemberNames: Readonly<Record<string, string>>
  /** ISO currency code of the trip — used to format amounts inline. */
  currency: string
  /** Current user uid — must equal `toUid` for the「已收款」button to
   *  enable. Receiver-only mirrors the Worker (settlement-create). */
  uid: string | null
  /** Capability, not identity: whether the current user may delete ANY
   *  settlement (not just their own records). The caller folds trip
   *  ownership with Schema Epoch compatibility (`canOwnerWrite`), so a
   *  blocked owner loses the affordance; the Worker's recorder-or-owner
   *  gate stays authoritative. */
  canDeleteAnySettlement: boolean
  /** Opens the record sheet: a suggestion the user confirms (transfer or
   *  offset), or「記錄收款」for a payment that doesn't match a suggestion.
   *  The page owns the sheet and the mutation. */
  onRecord: (intent: RecordIntent) => void
  /** Cancels a settlement — for a route, every leg (`hideIds`) goes with
   *  it. Used to clean up orphans or undo a premature record. */
  onDeleteSettlement: (id: string, hideIds?: string[]) => void
  /** Trip owner: may record the receipt for a receiver who has LEFT the
   *  trip (nobody else can confirm it any more). The Worker enforces it
   *  and marks the row `recordedOnBehalfOf`. */
  canRecordForDeparted?: boolean
}

export default function SettlementSummary({
  expenses, members, settlements, formerMemberNames, currency, uid, canDeleteAnySettlement,
  canRecordForDeparted = false, onRecord, onDeleteSettlement,
}: Props) {
  // computeBalancesFull also returns `participants` (members + ghosts
  // for kicked-out uids still in expenses/settlements). Reusing that
  // list avoids walking expenses/splits/settlements a second time.
  // `pairwise` is the same normalized debt-edge map the suggestion
  // engine walks — one row per real pair debt, matching what the Worker
  // validation reads to gate `amount <= remaining`.
  const { balances, orphans, participants, pairwise } = computeBalancesFull(expenses, members, settlements, formerMemberNames)
  // Simplified routes on real debt edges (settlement-core, same planner the
  // Worker's validation agrees with), each leg previewed with the expenses
  // it would clear.
  const suggestions = planRouteSuggestions(pairwise, expenses, settlements)
  const memberById  = new Map(participants.map(m => [m.id, m]))
  // 「記錄收款」: anyone the ledger can still explain paying me.
  const me = uid ? memberById.get(uid) : undefined
  const canRecordPayment = me != null && me.isGhost !== true
    && payersFor(pairwise, uid!, participants.map(m => m.id)).length > 0

  function recordSuggestion(s: RouteSuggestion) {
    if (s.kind === 'OFFSET') {
      onRecord({ kind: 'OFFSET', route: { kind: 'OFFSET', participantUids: s.participantUids, legs: s.legs.map(stripSources) } })
      return
    }
    onRecord({
      kind:        'TRANSFER',
      mode:        'suggestion',
      payerUid:    s.payerUid,
      receiverUid: s.receiverUid,
      amountMinor: s.amountMinor,
      planned:     { kind: 'TRANSFER', payerUid: s.payerUid, receiverUid: s.receiverUid, amountMinor: s.amountMinor, legs: s.legs.map(stripSources) },
    })
  }

  // `expenses` includes soft-deleted rows (passed through for chronological
  // replay). Active-expense visual regions (balance cards, suggestions,
  // "已清算" chip) need to gate on whether any LIVE expense exists --
  // otherwise tombstone-only trips render 0-amount balances + misleading
  // "all settled" chip. Short-circuit `some` is also the cheapest test for
  // the early-return guard below.
  const hasActiveExpenses = expenses.some(e => !e.deletedAt)

  // Hide the whole section when there's nothing actionable: no live
  // expense AND no settlement history. Surface when settlements exist
  // regardless of expense state -- orphan banner + history need to be
  // reachable even if every expense was soft-deleted.
  if (!hasActiveExpenses && settlements.length === 0) return null
  const allSettled = suggestions.length === 0
  const totalOrphanMinor = orphans.reduce((s, o) => s + o.amountMinor, 0)
  // Bucket orphan totals by reason so the warning banner can use
  // reason-specific copy. Typed against OrphanReason for exhaustiveness.
  const orphanByReason = orphans.reduce<Partial<Record<OrphanReason, number>>>((acc, o) => {
    acc[o.reason] = (acc[o.reason] ?? 0) + o.amountMinor
    return acc
  }, {})
  // Per-settlement lookup so each history row can render its own reason
  // chip without re-walking `orphans`. Map handles the "no orphan" case
  // by returning undefined.
  const orphanById = new Map(orphans.map(o => [o.settlementId, o]))

  return (
    <div className="px-4 mt-4">
      <div className="bg-surface border border-border rounded-[22px] px-5 pt-4 pb-4 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-muted tracking-[0.1em] uppercase">
            精算
          </div>
          {allSettled && hasActiveExpenses && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-card bg-teal-pale text-teal text-[10px] font-bold tracking-[0.04em]">
              <Check size={10} strokeWidth={3} />
              已清算
            </div>
          )}
        </div>

        {/* ── 每位成員的淨額 ────────────────────────────── */}
        {hasActiveExpenses && (
          <div className="flex flex-col gap-[3px]">
            {balances.map(b => {
              const m = memberById.get(b.memberId)!
              const netMinor = Math.round(b.net)
              const isCredit = netMinor > 0
              const isDebit  = netMinor < 0
              const absMinor = Math.abs(netMinor)
              return (
                <div key={b.memberId} className={[
                  'flex items-center gap-2.5 py-[3px]',
                  m.isGhost ? 'opacity-70' : '',
                ].join(' ')}>
                  <MemberAvatar member={m} size={28} />
                  <div className="flex-1 min-w-0">
                    <div
                      title={m.displayName}
                      className="truncate text-[12.5px] text-ink font-semibold leading-tight"
                    >
                      {m.displayName}
                    </div>
                    <div className="text-[10px] text-muted tabular-nums mt-px">
                      {m.isGhost && <span className="text-danger font-semibold">已退出 · </span>}
                      代墊 {formatMinorAmount(b.paid, currency)} · 分攤 {formatMinorAmount(b.owed, currency)}
                    </div>
                  </div>
                  <span
                    className={[
                      'text-[13.5px] font-extrabold tabular-nums -tracking-[0.2px]',
                      isCredit ? 'text-teal'
                        : isDebit ? 'text-danger'
                        : 'text-muted',
                    ].join(' ')}
                  >
                    {isCredit ? '+' : isDebit ? '-' : '±'}{formatMinorAmount(absMinor, currency)}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* ── 提案 ──────────────────────────────────────── */}
        {hasActiveExpenses && (allSettled ? (
          <div className="mt-3 pt-3 border-t border-dashed border-border text-center">
            <div className="text-[11.5px] text-muted leading-[1.5]">
              所有成員的帳務已平衡
            </div>
          </div>
        ) : (
          <>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="text-[10.5px] font-semibold text-muted tracking-[0.08em] uppercase mb-2">
              付款建議（{suggestions.filter(x => x.kind === 'TRANSFER').length} 筆付款{suggestions.some(x => x.kind === 'OFFSET') ? `、${suggestions.filter(x => x.kind === 'OFFSET').length} 組抵銷` : ''}）
            </div>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((sg, i) => (
                <SettlementRouteCard
                  key={sg.kind === 'TRANSFER'
                    ? `t-${sg.payerUid}-${sg.receiverUid}-${i}`
                    : `o-${sg.participantUids.join(',')}`}
                  suggestion={sg}
                  memberById={memberById}
                  currency={currency}
                  uid={uid}
                  canRecordForDeparted={canRecordForDeparted}
                  onRecord={recordSuggestion}
                />
              ))}
            </div>
          </>
        ))}

        {hasActiveExpenses && canRecordPayment && (
          <button
            type="button"
            onClick={() => onRecord({ kind: 'TRANSFER', mode: 'payment', receiverUid: uid! })}
            className="mt-2 w-full flex items-center justify-center gap-1.5 h-9 rounded-input border border-dashed border-border bg-transparent text-[11.5px] font-semibold text-teal cursor-pointer hover:bg-teal-pale"
          >
            <HandCoins size={13} strokeWidth={2.2} />
            記錄收款（金額或對象跟建議不同時）
          </button>
        )}

        {/* ── 已清算紀錄 + orphan 警告 ────────────────── */}
        {settlements.length > 0 && (
          <SettlementHistory
            expenses={expenses}
            settlements={settlements}
            memberById={memberById}
            currency={currency}
            uid={uid}
            canDeleteAnySettlement={canDeleteAnySettlement}
            totalOrphanMinor={totalOrphanMinor}
            orphanByReason={orphanByReason}
            orphanById={orphanById}
            onDelete={onDeleteSettlement}
          />
        )}
      </div>
    </div>
  )
}

function stripSources<L extends { fromUid: string; toUid: string; amountMinor: number; expectedRemainingMinor: number }>(leg: L) {
  return { fromUid: leg.fromUid, toUid: leg.toUid, amountMinor: leg.amountMinor, expectedRemainingMinor: leg.expectedRemainingMinor }
}
