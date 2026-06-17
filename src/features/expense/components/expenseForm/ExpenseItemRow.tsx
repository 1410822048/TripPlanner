// src/features/expense/components/expenseForm/ExpenseItemRow.tsx
// One receipt item row inside LineItemsSection: name + amount (+ trip-currency
// ≈ preview when foreign-open) on row 1, allocation chips + delete on row 2.
// Pure presentational — all state lives in the modal / useExpenseItems; this
// only renders and calls index-based callbacks. Split out of LineItemsSection
// to shorten the .map() body.
import { Minus, Plus, Trash2 } from 'lucide-react'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { compactInputClass } from '@/components/ui/inputStyle'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'

interface ExpenseItemRowProps {
  index:        number
  item:         FormItem
  members:      TripMember[]
  symbol:       string
  tripCurrency: string
  /** Trip-currency per-line FX preview for this row (undefined when not
   *  foreign-open / no rate yet). */
  convertedItemAmount: number | undefined
  onSetName:             (index: number, value: string) => void
  onSetAmount:           (index: number, value: string) => void
  onToggleAllocation:    (index: number, memberId: string) => void
  onSetAllocationShares: (index: number, memberId: string, shares: number) => void
  onRemove:              (index: number) => void
}

export default function ExpenseItemRow({
  index, item, members, symbol, tripCurrency, convertedItemAmount,
  onSetName, onSetAmount, onToggleAllocation, onSetAllocationShares, onRemove,
}: ExpenseItemRowProps) {
  const allocationByMember = new Map(item.allocations.map(a => [a.memberId, a]))

  return (
    <div className="flex flex-col gap-1.5 px-2.5 py-2.5">
      {/* Row 1: name + amount. Amount widened to 120px (was 100px) so
          5-digit JPY values like ¥10,000 fit without clipping. Delete
          lives on row 2's trailing edge, not here. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
        {/* Font-size MUST be 16px or larger — iOS Safari auto-zooms the
            viewport on focus of any input below 16px. Keep compact rows
            descender-safe with explicit leading/padding. */}
        <input
          value={item.name}
          onChange={e => onSetName(index, e.target.value)}
          placeholder="項目名"
          className={compactInputClass(false)}
        />
        <div className="min-w-0">
          <CurrencyInput
            symbol={symbol}
            size="compact"
            alignRight
            shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
            value={item.amountText}
            onChange={e => onSetAmount(index, e.target.value)}
            placeholder="0"
          />
          {convertedItemAmount !== undefined && (
            <div className="mt-1 text-right text-[10.5px] font-semibold text-muted tabular-nums">
              ≈ {formatMinorAmount(convertedItemAmount, tripCurrency)}
            </div>
          )}
        </div>
      </div>

      {/* Row 2: allocation chips + delete trailing.
          Splitwise-style "primary action area / cleanup tail". */}
      <div className="flex items-center gap-1.5">
        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {members.map(m => {
            const allocation = allocationByMember.get(m.id)
            if (!allocation) {
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => onToggleAllocation(index, m.id)}
                  className="min-h-8 inline-flex items-center gap-1 rounded-full border border-border bg-app pl-1 pr-2 text-[11px] text-muted transition-colors hover:border-muted"
                >
                  <MemberAvatar member={m} size={20} />
                  <span className="max-w-[5rem] truncate">{m.label}</span>
                </button>
              )
            }

            return (
              <div
                key={m.id}
                className="min-h-8 inline-flex items-center gap-1 rounded-full border border-accent/35 bg-teal-pale pl-1 pr-1 text-[11px] font-semibold text-teal"
              >
                <button
                  type="button"
                  onClick={() => onToggleAllocation(index, m.id)}
                  className="inline-flex min-w-0 items-center gap-1"
                  aria-label={`${m.label} を分担から外す`}
                >
                  <MemberAvatar member={m} size={20} />
                  <span className="max-w-[4rem] truncate">{m.label}</span>
                  <span className="tabular-nums">x{allocation.shares}</span>
                </button>
                <span className="h-4 w-px bg-accent/20" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => {
                    if (allocation.shares <= 1) onToggleAllocation(index, m.id)
                    else onSetAllocationShares(index, m.id, allocation.shares - 1)
                  }}
                  aria-label={`${m.label} の分担数を減らす`}
                  className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/60"
                >
                  <Minus size={12} strokeWidth={2.4} />
                </button>
                <button
                  type="button"
                  onClick={() => onSetAllocationShares(index, m.id, allocation.shares + 1)}
                  aria-label={`${m.label} の分担数を増やす`}
                  className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/60"
                >
                  <Plus size={12} strokeWidth={2.4} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => onRemove(index)}
          aria-label={`行 ${index + 1} を削除`}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
