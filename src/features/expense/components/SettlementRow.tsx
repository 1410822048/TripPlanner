// src/features/expense/components/SettlementRow.tsx
// A single「清算済み」record row inside the settlement history list.
// Renders the from→to avatars, the cleared amount (two-line when the payee
// recorded a foreign-currency receipt), an optional orphan reason chip, and
// the two-tap delete affordance. Pure presentation — the parent decides
// canDelete and supplies the orphan classification.
import { useState } from 'react'
import { ArrowRight, AlertCircle, Trash2 } from 'lucide-react'
import type { Expense } from '@/types'
import type { SettlementAppliedSource, SettlementRecord } from '@/types/settlement'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
import type { OrphanSettlement } from '../services/settlement'
import { formatMinorAmount } from '@/utils/money'
import { ORPHAN_REASON_COPY, ORPHAN_REASON_LABEL } from './settlementOrphanCopy'

function sourceLabel(source: SettlementAppliedSource, currency: string): string {
  const name = source.itemName
    ? `${source.expenseTitle} / ${source.itemName}`
    : source.expenseTitle
  return `${name} ${formatMinorAmount(source.amountMinor, currency)}`
}

function orphanSourceHint(
  record:   SettlementRecord,
  expenses: Expense[],
  currency: string,
): string | null {
  const sources = record.appliedSources ?? []
  if (sources.length === 0) return null

  const expenseById = new Map(expenses.map(e => [e.id, e]))
  // Only sources we can RELIABLY attribute to the orphan: a deleted/missing
  // expense, or a missing item. An amount / split / adjustment edit leaves
  // the expense + item present, so we can't tell which source shifted the
  // balance — don't fall back to sources[0] (that misreports the wrong
  // source for a multi-source settlement). Show a generic note instead.
  const affected = sources.filter(source => {
    const expense = expenseById.get(source.expenseId)
    if (!expense || expense.deletedAt) return true
    if (!source.itemId) return false
    return !(expense.items ?? []).some(item => item.id === source.itemId)
  })
  if (affected.length === 0) {
    return '清算後可能有費用被變更過。'
  }
  return `來源：${affected.map(source => sourceLabel(source, currency)).join('、')}`
}

interface RowProps {
  record:    SettlementRecord
  from:      TripMember
  to:        TripMember
  currency:  string
  expenses:  Expense[]
  canDelete: boolean
  /** Present when this row's settlement is orphan -- renders an inline
   *  reason chip between amount and the delete button. Undefined for
   *  matched settlements. */
  orphan?:   OrphanSettlement
  onDelete:  () => void
}

export default function SettlementRow({ record, from, to, currency, expenses, canDelete, orphan, onDelete }: RowProps) {
  // Two-tap confirm: matches the swipe-to-delete pattern elsewhere in
  // the app — first tap arms the action with a red label, second tap
  // commits. Keeps a single accidental tap from wiping a settlement.
  const [confirming, setConfirming] = useState(false)

  // Settlement FX Commit 3/4 — foreign-currency rows render two-line:
  // source amount on top (what the payee actually received), trip-
  // currency canonical below (what feeds into the balance engine). The
  // type-level `sourceCurrency !== undefined` check is the same group
  // gate the schema-level superRefine in SettlementDocSchema enforces,
  // so this branch is only entered when sourceAmountMinor is also
  // guaranteed present.
  const isForeign = record.sourceCurrency !== undefined
  const sourceHint = orphan ? orphanSourceHint(record, expenses, currency) : null

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 bg-app rounded-input">
      <MemberAvatar member={from} size={20} />
      <ArrowRight size={10} strokeWidth={2.5} className="text-muted shrink-0" />
      <MemberAvatar member={to} size={20} />
      <div className="flex-1 min-w-0 tabular-nums -tracking-[0.2px] leading-tight">
        {isForeign ? (
          <>
            <div className="text-[11.5px] font-semibold text-ink">
              {formatMinorAmount(record.sourceAmountMinor!, record.sourceCurrency!)}
            </div>
            <div className="text-[10px] text-muted font-medium mt-px">
              {formatMinorAmount(record.amountMinor, currency)}
            </div>
          </>
        ) : (
          <div className="text-[11.5px] font-semibold text-ink">
            {formatMinorAmount(record.amountMinor, currency)}
          </div>
        )}
        {sourceHint && (
          <div className="text-[10px] text-muted font-medium mt-px truncate" title={sourceHint}>
            {sourceHint}
          </div>
        )}
      </div>
      {orphan && (
        <span
          aria-label={`未對應 · ${ORPHAN_REASON_LABEL[orphan.reason]} ${formatMinorAmount(orphan.amountMinor, currency)}`}
          title={ORPHAN_REASON_COPY[orphan.reason]}
          className="shrink-0 inline-flex items-center gap-0.5 px-1.5 h-5 rounded-full text-[9.5px] font-bold tracking-[0.02em]"
          style={{ background: '#FFF4E0', color: '#7A4A12', border: '1px solid #F0D49B' }}
        >
          <AlertCircle size={9} strokeWidth={2.5} />
          {ORPHAN_REASON_LABEL[orphan.reason]} {formatMinorAmount(orphan.amountMinor, currency)}
        </span>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={() => {
            if (confirming) onDelete()
            else setConfirming(true)
          }}
          onBlur={() => setConfirming(false)}
          aria-label={confirming
            ? '清算記録の削除を確認'
            : '清算記録を削除'}
          className={[
            'shrink-0 flex items-center gap-0.5 px-2 h-6 rounded-full border-none text-[10px] font-bold tracking-[0.04em] cursor-pointer transition-colors',
            confirming
              ? 'bg-danger text-white'
              : 'bg-transparent text-muted hover:bg-border',
          ].join(' ')}
        >
          {confirming ? '確認' : <Trash2 size={11} strokeWidth={2} />}
        </button>
      )}
    </div>
  )
}
