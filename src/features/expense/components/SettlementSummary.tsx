// src/features/expense/components/SettlementSummary.tsx
import { ArrowRight, Check, Clock } from 'lucide-react'
import type { Expense } from '@/types'
import type { SettlementRecord } from '@/types/settlement'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
import {
  computeBalancesFull,
  type OrphanReason,
} from '../services/settlement'
import { computeSettlementSuggestions } from '../services/settlementSuggestions'
import { formatMinorAmount } from '@/utils/money'
import SettlementHistory from './SettlementHistory'

interface Props {
  expenses:    Expense[]
  members:     TripMember[]
  settlements: SettlementRecord[]
  /** ISO currency code of the trip — used to format amounts inline. */
  currency: string
  /** Current user uid — must equal `toUid` for the「済み」button to
   *  enable. Receiver-only mirrors the Worker (settlement-create). */
  uid: string | null
  /** Trip owner — enables deleting ANY settlement (not just one's own
   *  records), mirroring the Worker's recorder-or-owner delete gate. */
  isOwner: boolean
  /** Opens the settlement record sheet preseeded with the suggestion the
   *  receiver tapped. The sheet (lives at the page level) does the actual
   *  mutate; this component just bubbles the intent up. Settlement FX
   *  Commit 3/4 + Phase 4.1 replaced the previous one-click `onMarkSettled`
   *  with this two-step flow so the receiver can pick which currency they
   *  actually received in (for display + audit). The ledger amount is
   *  always the full pair-remaining — the sheet never lets the receiver
   *  override the cleared amount, only the source currency / date. */
  onRecordSettlement: (suggestion: { fromUid: string; toUid: string; amountMinor: number }) => void
  /** Removes a previously recorded settlement. Used to clean up
   *  orphans whose expense was deleted, or to undo a premature「済み」. */
  onDeleteSettlement: (id: string) => void
}

export default function SettlementSummary({
  expenses, members, settlements, currency, uid, isOwner,
  onRecordSettlement, onDeleteSettlement,
}: Props) {
  // computeBalancesFull also returns `participants` (members + ghosts
  // for kicked-out uids still in expenses/settlements). Reusing that
  // list avoids walking expenses/splits/settlements a second time.
  // `pairwise` is the same normalized debt-edge map the suggestion
  // engine walks — one row per real pair debt, matching what the Worker
  // validation reads to gate `amount <= remaining`.
  const { balances, orphans, participants, pairwise, gross, applied } = computeBalancesFull(expenses, members, settlements)
  // Domain-enriched suggestions: each carries an optional `settledContext`
  // (應清算 / 已清算 / 還差) for a partially-cleared pair. The "is the
  // breakdown mathematically explicable" decision lives in the service.
  const suggestions = computeSettlementSuggestions({ pairwise, gross, applied })
  const memberById  = new Map(participants.map(m => [m.id, m]))

  // `expenses` includes soft-deleted rows (passed through for chronological
  // replay). Active-expense visual regions (balance cards, suggestions,
  // "清算済み" chip) need to gate on whether any LIVE expense exists --
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
                    <div className="text-[12.5px] text-ink font-semibold leading-tight">
                      {m.label}
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
              付款建議（{suggestions.length} 筆）
            </div>
            <div className="flex flex-col gap-1.5">
              {suggestions.map((s, i) => {
                const from = memberById.get(s.fromId)!
                const to   = memberById.get(s.toId)!
                // Receiver-only: only the payee (toId) can mark settled.
                // Payer / third-party see a status pill, not a button.
                const canRecord = uid != null && uid === s.toId
                const isPayer   = uid != null && uid === s.fromId
                // settledContext (應清算 / 已清算 / 還差) is computed in the
                // settlement domain — the UI just renders it when present.
                const settled   = s.settledContext
                return (
                  <div
                    key={`${s.fromId}-${s.toId}-${i}`}
                    className="flex items-center gap-2 px-2.5 py-2 bg-app rounded-input border border-border"
                  >
                    <MemberAvatar member={from} size={28} />
                    <ArrowRight size={12} strokeWidth={2.5} className="text-muted shrink-0" />
                    <MemberAvatar member={to}   size={28} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[14.5px] font-extrabold text-ink tabular-nums -tracking-[0.2px]">
                        {formatMinorAmount(s.amountMinor, currency)}
                      </div>
                      {settled && (
                        <div className="text-[10px] text-muted font-medium tabular-nums mt-px">
                          應清算 {formatMinorAmount(settled.grossMinor, currency)}，已清算 {formatMinorAmount(settled.appliedMinor, currency)}
                        </div>
                      )}
                    </div>
                    {canRecord ? (
                      <button
                        type="button"
                        onClick={() => onRecordSettlement({
                          fromUid:     s.fromId,
                          toUid:       s.toId,
                          amountMinor: s.amountMinor,
                        })}
                        aria-label={`記錄已收到 ${from.label} 支付的 ${formatMinorAmount(s.amountMinor, currency)}`}
                        className="shrink-0 flex items-center gap-1 px-2.5 h-7 rounded-full border-none bg-teal text-white text-[10.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
                      >
                        <Check size={11} strokeWidth={2.8} />
                        已收款
                      </button>
                    ) : (
                      <div
                        role="status"
                        aria-label={isPayer
                          ? `等待收款人（${to.label}）確認`
                          : `尚未確認 ${from.label} 支付給 ${to.label} 的清算`}
                        title={isPayer ? '由收款人（不是你）確認' : undefined}
                        className="shrink-0 flex items-center gap-1 px-2.5 h-7 rounded-full bg-app text-muted text-[10.5px] font-medium tracking-[0.04em] opacity-75"
                      >
                        <Clock size={11} strokeWidth={2.4} />
                        等待收款
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        ))}

        {/* ── 清算済み記録 + orphan 警告 ────────────────── */}
        {settlements.length > 0 && (
          <SettlementHistory
            expenses={expenses}
            settlements={settlements}
            memberById={memberById}
            currency={currency}
            uid={uid}
            isOwner={isOwner}
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
