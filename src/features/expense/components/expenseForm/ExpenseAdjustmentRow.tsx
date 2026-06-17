// src/features/expense/components/expenseForm/ExpenseAdjustmentRow.tsx
// One adjustment row (割引/税/調整) inside LineItemsSection: label + signed
// amount (+ ≈ preview), kind/scope/delete controls, optional ITEM-scope
// target select, and the 「誰に効くか」 summary. Pure presentational — split
// out of LineItemsSection to shorten the .map() body; no behavior change.
import { Trash2 } from 'lucide-react'
import {
  EXPENSE_ADJUSTMENT_KINDS,
  type ExpenseAdjustment,
  type ExpenseAdjustmentKind,
  type ExpenseAdjustmentScope,
} from '@/types'
import { adjustmentSign } from '@tripmate/expense-materialize'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { compactInputClass } from '@/components/ui/inputStyle'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'

const ADJUSTMENT_KIND_LABEL: Record<ExpenseAdjustmentKind, string> = {
  DISCOUNT:   '割引',
  COUPON:     'クーポン',
  TAX_EXEMPT: '免税',
  SURCHARGE:  '追加料金',
  TAX:        '税',
  TIP:        'チップ',
  OTHER:      'その他',
}

const ADJUSTMENT_SCOPE_OPTIONS: { value: ExpenseAdjustmentScope; label: string }[] = [
  { value: 'EXPENSE', label: '全体' },
  { value: 'ITEM',    label: '項目' },
]

interface ExpenseAdjustmentRowProps {
  index:        number
  adjustment:   ExpenseAdjustment
  /** Sibling item list — feeds the ITEM-scope target select + the
   *  「誰に効くか」 summary lookup. */
  items:        FormItem[]
  members:      TripMember[]
  symbol:       string
  tripCurrency: string
  /** Inflight display text for the amount (typed value else the formatted
   *  minor amount under the effective currency). */
  amountValue:  string
  /** Trip-currency ≈ preview for this adjustment (undefined when not foreign). */
  convertedAdjustmentAmount: number | undefined
  onSetLabel:  (id: string, value: string) => void
  onSetAmount: (id: string, value: string) => void
  onSetKind:   (id: string, kind: ExpenseAdjustmentKind) => void
  onSetScope:  (id: string, scope: ExpenseAdjustmentScope, itemIds: string[]) => void
  onSetTarget: (id: string, targetItemId: string) => void
  onRemove:    (id: string) => void
}

export default function ExpenseAdjustmentRow({
  index, adjustment: adj, items, members, symbol, tripCurrency,
  amountValue, convertedAdjustmentAmount,
  onSetLabel, onSetAmount, onSetKind, onSetScope, onSetTarget, onRemove,
}: ExpenseAdjustmentRowProps) {
  const sign = adjustmentSign(adj.kind)
  // UX B — who this adjustment hits: 全体 for EXPENSE scope, the target
  // item + its allocated members for ITEM scope. Makes 「クーポン −¥30」legible
  // (扣哪個項目 / 影響誰).
  const targetItem = adj.scope === 'ITEM'
    ? items.find(it => it.id === adj.targetItemId)
    : undefined
  const targetAllocationMembers = targetItem
    ? members.filter(m => targetItem.allocations.some(a => a.memberId === m.id))
    : []
  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
        <input
          value={adj.label}
          onChange={e => onSetLabel(adj.id, e.target.value)}
          placeholder={`調整 ${index + 1}`}
          aria-label={`調整 ${index + 1} ラベル`}
          className={compactInputClass(false)}
        />
        <div className="min-w-0">
          <CurrencyInput
            symbol={`${sign < 0 ? '-' : '+'}${symbol}`}
            size="compact"
            alignRight
            shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
            value={amountValue}
            onChange={e => onSetAmount(adj.id, e.target.value)}
            placeholder="0"
            aria-label={`調整 ${index + 1} 金額`}
          />
          {convertedAdjustmentAmount !== undefined && (
            <div className="mt-1 text-right text-[10.5px] font-semibold text-muted tabular-nums">
              ≈ {sign < 0 ? '-' : '+'}{formatMinorAmount(convertedAdjustmentAmount, tripCurrency)}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-center">
        <select
          value={adj.kind}
          onChange={e => onSetKind(adj.id, e.target.value as ExpenseAdjustmentKind)}
          aria-label={`調整 ${index + 1} 種類`}
          className={compactInputClass(false)}
        >
          {EXPENSE_ADJUSTMENT_KINDS.map(kind => (
            <option key={kind} value={kind}>{ADJUSTMENT_KIND_LABEL[kind]}</option>
          ))}
        </select>

        <select
          value={adj.scope}
          onChange={e => onSetScope(adj.id, e.target.value as ExpenseAdjustmentScope, items.map(it => it.id))}
          aria-label={`調整 ${index + 1} 対象範囲`}
          className={compactInputClass(false)}
        >
          {ADJUSTMENT_SCOPE_OPTIONS.map(scope => (
            <option key={scope.value} value={scope.value}>{scope.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => onRemove(adj.id)}
          aria-label={`調整 ${index + 1} を削除`}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>

      {adj.scope === 'ITEM' && (
        <select
          value={adj.targetItemId ?? ''}
          onChange={e => onSetTarget(adj.id, e.target.value)}
          aria-label={`調整 ${index + 1} 対象項目`}
          className={compactInputClass(false)}
        >
          <option value="" disabled>対象項目を選択</option>
          {items.map((item, itemIndex) => (
            <option key={item.id} value={item.id}>
              {item.name.trim() || `行 ${itemIndex + 1}`}
            </option>
          ))}
        </select>
      )}

      {/* UX B — 「誰に効くか」 summary. EXPENSE = 全体; ITEM = target item
          name + its allocation member avatars. */}
      {adj.scope === 'EXPENSE' ? (
        <div className="text-[10.5px] text-muted">対象: 全体</div>
      ) : targetItem ? (
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted min-w-0">
          <span className="shrink-0">対象:</span>
          <span className="truncate font-medium text-ink">
            {targetItem.name.trim() || '項目'}
          </span>
          {targetAllocationMembers.length > 0 && (
            <span className="flex items-center gap-0.5 shrink-0">
              {targetAllocationMembers.map(m => (
                <MemberAvatar key={m.id} member={m} size={16} />
              ))}
            </span>
          )}
        </div>
      ) : null}
    </div>
  )
}
