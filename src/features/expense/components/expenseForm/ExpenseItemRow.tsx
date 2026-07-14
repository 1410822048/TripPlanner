// src/features/expense/components/expenseForm/ExpenseItemRow.tsx
// One receipt item row inside LineItemsSection: name + amount (+ trip-currency
// ≈ preview when foreign-open) on row 1, allocation chips + delete on row 2.
// Pure presentational — all state lives in the modal / useExpenseItems; this
// only renders and calls index-based callbacks. Split out of LineItemsSection
// to shorten the .map() body.
import { useState } from 'react'
import { ChevronRight, Trash2, Users } from 'lucide-react'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { compactInputClass } from '@/components/ui/inputStyle'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'
import ExpenseItemAllocationSheet from './ExpenseItemAllocationSheet'

interface ExpenseItemRowProps {
  index:        number
  item:         FormItem
  members:      TripMember[]
  /** Effective currency (source currency when foreign-open, else trip). */
  currency:     string
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
  index, item, members, currency, symbol, tripCurrency, convertedItemAmount,
  onSetName, onSetAmount, onToggleAllocation, onSetAllocationShares, onRemove,
}: ExpenseItemRowProps) {
  const [allocationOpen, setAllocationOpen] = useState(false)
  const memberById = new Map(members.map(member => [member.id, member]))
  const allocatedMembers = item.allocations
    .map(allocation => memberById.get(allocation.memberId))
    .filter((member): member is TripMember => !!member)
  const totalShares = item.allocations.reduce((sum, allocation) => sum + allocation.shares, 0)
  const allocationLabel = item.allocations.length === 0
    ? '選擇分攤者'
    : `${item.allocations.length}人 / ${totalShares}份`

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

      {/* Row 2: allocation summary + delete trailing. Detailed per-member
          shares live in a sheet so rows stay stable when trips have many
          members. */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setAllocationOpen(true)}
          className={[
            'flex min-h-9 flex-1 items-center gap-2 rounded-[14px] border px-2 py-1.5 text-left transition-colors',
            item.allocations.length > 0
              ? 'border-accent/30 bg-teal-pale text-teal'
              : 'border-border bg-app text-muted hover:border-muted',
          ].join(' ')}
        >
          {allocatedMembers.length > 0 ? (
            <span className="flex shrink-0 -space-x-1">
              {allocatedMembers.slice(0, 3).map(member => (
                <MemberAvatar
                  key={member.id}
                  member={member}
                  size={22}
                  className="border-[1.5px] border-surface"
                />
              ))}
            </span>
          ) : (
            <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-surface text-muted">
              <Users size={13} strokeWidth={2.2} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[12px] font-bold tabular-nums">
            {allocationLabel}
          </span>
          <ChevronRight size={14} strokeWidth={2.4} className="shrink-0 opacity-70" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          aria-label={`刪除第 ${index + 1} 行`}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>

      <ExpenseItemAllocationSheet
        isOpen={allocationOpen}
        item={item}
        index={index}
        members={members}
        currency={currency}
        onClose={() => setAllocationOpen(false)}
        onToggleAllocation={onToggleAllocation}
        onSetAllocationShares={onSetAllocationShares}
      />
    </div>
  )
}
