// src/features/expense/components/expenseForm/ExpenseItemRow.tsx
// One receipt item row inside LineItemsSection: name + amount (+ trip-currency
// ≈ preview when foreign-open) on row 1, assignee chips + delete on row 2.
// Pure presentational — all state lives in the modal / useExpenseItems; this
// only renders and calls index-based callbacks. Split out of LineItemsSection
// to shorten the .map() body; no behavior change.
import { Trash2 } from 'lucide-react'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberChip from '@/components/ui/MemberChip'
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
  onSetName:        (index: number, value: string) => void
  onSetAmount:      (index: number, value: string) => void
  onToggleAssignee: (index: number, memberId: string) => void
  onRemove:         (index: number) => void
}

export default function ExpenseItemRow({
  index, item, members, symbol, tripCurrency, convertedItemAmount,
  onSetName, onSetAmount, onToggleAssignee, onRemove,
}: ExpenseItemRowProps) {
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

      {/* Row 2: assignee chips + delete trailing.
          Splitwise-style "primary action area / cleanup tail". */}
      <div className="flex items-center gap-1.5">
        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {members.map(m => (
            <MemberChip
              key={m.id}
              member={m}
              active={item.assignees.includes(m.id)}
              onClick={() => onToggleAssignee(index, m.id)}
              size="sm"
            />
          ))}
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
