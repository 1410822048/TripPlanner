// src/features/expense/components/SettlementSummary.tsx
import { ArrowRight, Check } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { computeBalances, computeSettlements, expandWithGhosts } from '../services/settlement'
import { formatAmount } from '@/utils/currency'

interface Props {
  expenses: Expense[]
  members:  TripMember[]
  /** ISO currency code of the trip — included in props (not hooked
   *  internally) so the memo comparator below catches changes when
   *  the user updates currency mid-trip. */
  currency: string
}

function MemberChip({ m, size = 28 }: { m: TripMember; size?: number }) {
  return (
    <span
      className="rounded-full flex items-center justify-center font-bold shrink-0"
      style={{
        width: size, height: size,
        background: m.bg, color: m.color,
        fontSize: size * 0.42,
      }}
    >
      {m.label}
    </span>
  )
}

function SettlementSummary({ expenses, members, currency }: Props) {
  // Expand `members` with ghost rows for any uid in expenses that's no
  // longer an active trip member. Without this, the chip lookups below
  // would silently `return null` for kicked-out members and their
  // amounts would visually disappear from settlement — even though the
  // math still includes them. Doing the expand here keeps the page
  // self-contained: callers pass `members` (active only) and we
  // surface the full list to render.
  // No useMemo — React Compiler auto-memoises these derivations based
  // on its inferred deps. Manual useMemo was redundant boilerplate.
  const allParticipants = expandWithGhosts(members, expenses)
  const balances        = computeBalances(expenses, allParticipants)
  const settlements     = computeSettlements(balances)
  const memberById      = new Map(allParticipants.map(m => [m.id, m]))

  if (expenses.length === 0) return null

  const allSettled = settlements.length === 0

  return (
    <div className="px-4 mt-4">
      <div className="bg-surface border border-border rounded-[22px] px-5 pt-4 pb-4 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] font-semibold text-muted tracking-[0.1em] uppercase">
            精算
          </div>
          {allSettled && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-card bg-teal-pale text-teal text-[10px] font-bold tracking-[0.04em]">
              <Check size={10} strokeWidth={3} />
              清算済み
            </div>
          )}
        </div>

        {/* ── 每位成員的淨額 ────────────────────────────── */}
        <div className="flex flex-col gap-[3px]">
          {balances.map(b => {
            // memberById is expandWithGhosts-backed → never misses.
            // Non-null assertion is safe here because every balance row
            // came from the same participant list we built memberById from.
            const m = memberById.get(b.memberId)!
            const isCredit = b.net > 0.5
            const isDebit  = b.net < -0.5
            const rounded  = Math.round(Math.abs(b.net))
            return (
              <div key={b.memberId} className={[
                'flex items-center gap-2.5 py-[3px]',
                m.isGhost ? 'opacity-70' : '',
              ].join(' ')}>
                <MemberChip m={m} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] text-ink font-semibold leading-tight">
                    {m.label}
                  </div>
                  <div className="text-[10px] text-muted tabular-nums mt-px">
                    {m.isGhost && <span className="text-danger font-semibold">退出済み · </span>}
                    立替 {formatAmount(b.paid, currency)} · 分担 {formatAmount(b.owed, currency)}
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
                  {isCredit ? '+' : isDebit ? '-' : '±'}{formatAmount(rounded, currency)}
                </span>
              </div>
            )
          })}
        </div>

        {/* ── 提案 ──────────────────────────────────────── */}
        {allSettled ? (
          <div className="mt-3 pt-3 border-t border-dashed border-border text-center">
            <div className="text-[11.5px] text-muted leading-[1.5]">
              全員の支払いがバランスしています 🎉
            </div>
          </div>
        ) : (
          <>
            <div className="my-3 border-t border-dashed border-border" />
            <div className="text-[10.5px] font-semibold text-muted tracking-[0.08em] uppercase mb-2">
              支払い提案（{settlements.length}件）
            </div>
            <div className="flex flex-col gap-1.5">
              {settlements.map((s, i) => {
                // memberById is ghost-backed → both lookups always hit.
                const from = memberById.get(s.fromId)!
                const to   = memberById.get(s.toId)!
                return (
                  <div
                    key={`${s.fromId}-${s.toId}-${i}`}
                    className="flex items-center gap-2 px-2.5 py-2 bg-app rounded-input border border-border"
                  >
                    <MemberChip m={from} size={24} />
                    <ArrowRight size={12} strokeWidth={2.5} className="text-muted shrink-0" />
                    <MemberChip m={to}   size={24} />
                    <span className="flex-1 text-[11.5px] text-muted leading-tight">
                      <span className="font-semibold text-ink">{from.label}</span>
                      <span className="mx-1 text-muted">→</span>
                      <span className="font-semibold text-ink">{to.label}</span>
                    </span>
                    <span className="text-[13.5px] font-extrabold text-ink tabular-nums -tracking-[0.2px]">
                      {formatAmount(s.amount, currency)}
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Memoised: ExpensePage state changes (modal toggle, swipe, etc.) cascade
// here even when expenses[] / members[] are unchanged. Default Object.is
// comparison is correct — both props come from stable upstream sources
// (TanStack Query cache for expenses, useMemo'd members).
export default SettlementSummary
