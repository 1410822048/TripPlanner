// src/features/expense/components/expenseForm/ExpenseAdjustmentRow.tsx
// One adjustment row (折扣/稅金/調整) inside LineItemsSection: label + signed
// amount (+ ≈ preview), kind/scope/delete controls, optional ITEM-scope
// target select, and the 適用範圍 summary. Pure presentational — split
// out of LineItemsSection to shorten the .map() body; no behavior change.
import { Trash2 } from 'lucide-react'
import {
  EXPENSE_ADJUSTMENT_KINDS,
  type ExpenseAdjustment,
  type ExpenseAdjustmentKind,
  type ExpenseAdjustmentScope,
} from '@/types/expense'
import { adjustmentSign } from '@tripmate/expense-materialize'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberAvatar from '@/components/ui/MemberAvatar'
import SingleSelectPicker, { type SingleSelectOption } from '@/components/ui/SingleSelectPicker'
import { compactInputClass } from '@/components/ui/inputStyle'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'

const ADJUSTMENT_KIND_LABEL: Record<ExpenseAdjustmentKind, string> = {
  DISCOUNT:   '折扣',
  COUPON:     '優惠券',
  TAX_EXEMPT: '免稅',
  SURCHARGE:  '附加費',
  TAX:        '稅金',
  TIP:        '小費',
  OTHER:      '其他',
}

const ADJUSTMENT_KIND_PREFIX: Record<ExpenseAdjustmentKind, string> = {
  DISCOUNT:   '折',
  COUPON:     '券',
  TAX_EXEMPT: '免',
  SURCHARGE:  '加',
  TAX:        '稅',
  TIP:        '費',
  OTHER:      '其',
}

const ADJUSTMENT_KIND_OPTIONS: readonly SingleSelectOption[] = EXPENSE_ADJUSTMENT_KINDS.map(kind => ({
  value:  kind,
  prefix: ADJUSTMENT_KIND_PREFIX[kind],
  label:  ADJUSTMENT_KIND_LABEL[kind],
}))

const ADJUSTMENT_SCOPE_OPTIONS: readonly SingleSelectOption[] = [
  { value: 'EXPENSE', prefix: '全', label: '整筆費用' },
  { value: 'ITEM',    prefix: '項', label: '指定項目' },
]

interface ExpenseAdjustmentRowProps {
  index:        number
  adjustment:   ExpenseAdjustment
  /** Sibling item list — feeds the ITEM-scope target select + the
   *  適用範圍 summary lookup. */
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
  // UX B — who this adjustment hits: the entire expense or the target
  // item + its allocated members. Makes a coupon adjustment legible
  // (扣哪個項目 / 影響誰).
  const targetItem = adj.scope === 'ITEM'
    ? items.find(it => it.id === adj.targetItemId)
    : undefined
  const targetAllocationMembers = targetItem
    ? members.filter(m => targetItem.allocations.some(a => a.memberId === m.id))
    : []
  const targetItemOptions: readonly SingleSelectOption[] = items.map((item, itemIndex) => ({
    value:  item.id,
    prefix: String(itemIndex + 1),
    label:  item.name.trim() || `行 ${itemIndex + 1}`,
  }))
  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
        <input
          value={adj.label}
          onChange={e => onSetLabel(adj.id, e.target.value)}
          placeholder={`調整 ${index + 1}`}
          aria-label={`調整 ${index + 1} 的標籤`}
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
        <SingleSelectPicker
          value={adj.kind}
          options={ADJUSTMENT_KIND_OPTIONS}
          title="選擇調整類型"
          placeholder="選擇類型"
          ariaLabel={`調整 ${index + 1} 種類`}
          onChange={kind => onSetKind(adj.id, kind as ExpenseAdjustmentKind)}
        />

        <SingleSelectPicker
          value={adj.scope}
          options={ADJUSTMENT_SCOPE_OPTIONS}
          title="選擇適用範圍"
          placeholder="選擇範圍"
          ariaLabel={`調整 ${index + 1} 適用範圍`}
          onChange={scope => onSetScope(
            adj.id,
            scope as ExpenseAdjustmentScope,
            items.map(item => item.id),
          )}
        />

        <button
          type="button"
          onClick={() => onRemove(adj.id)}
          aria-label={`刪除調整 ${index + 1}`}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
        >
          <Trash2 size={13} strokeWidth={2} />
        </button>
      </div>

      {adj.scope === 'ITEM' && (
        <SingleSelectPicker
          value={adj.targetItemId ?? ''}
          options={targetItemOptions}
          title="選擇目標項目"
          placeholder="選擇目標項目"
          ariaLabel={`調整 ${index + 1} 適用項目`}
          onChange={targetItemId => onSetTarget(adj.id, targetItemId)}
          required
        />
      )}

      {/* UX B — 適用範圍摘要。EXPENSE = 整筆費用; ITEM = target item
          name + its allocation member avatars. */}
      {adj.scope === 'EXPENSE' ? (
        <div className="text-[10.5px] text-muted">適用範圍：整筆費用</div>
      ) : targetItem ? (
        <div className="flex items-center gap-1.5 text-[10.5px] text-muted min-w-0">
          <span className="shrink-0">適用範圍：</span>
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
