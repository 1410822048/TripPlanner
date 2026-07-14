// src/features/expense/components/expenseForm/LineItemsSection.tsx
// Pure presentational section for the by-item「明細」 domain — receipt item
// rows, adjustment rows (割引/税/調整), the add-row/add-adjustment buttons,
// and the sum-check banner. Rendered instead of SplitsSection when
// items.length > 0.
//
// Items + adjustments are deliberately ONE section, not two: they share the
// item list (ITEM-scope adjustments target a row), the foreign preview map,
// and the sum check. Splitting them into two sibling sections would force the
// adjustment half to take the item list + preview + diff as props anyway,
// scattering them worse. The per-row render bodies ARE split out though —
// ExpenseItemRow / ExpenseAdjustmentRow — purely to shorten this file; they
// stay dumb (props in, UI + index/id callbacks out) and own no state.
//
// Split out of ExpenseFormModal (item 4). All state / hooks / derived math
// stay in the modal; this component only renders + calls back. It does NOT
// import useExpenseItems / useExpenseMoneyDraft — the modal hands in the
// already-derived values and the individual handlers.
import { Plus } from 'lucide-react'
import type {
  ExpenseAdjustment,
  ExpenseAdjustmentKind,
  ExpenseAdjustmentScope,
} from '@/types'
import FormField from '@/components/ui/FormField'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'
import type { ForeignLinePreview } from '../../services/buildForeignLinePreview'
import ExpenseItemRow from './ExpenseItemRow'
import ExpenseAdjustmentRow from './ExpenseAdjustmentRow'

interface LineItemsSectionProps {
  error:               string | undefined
  members:             TripMember[]
  /** Effective currency (source currency when foreign-open, else trip). */
  currency:            string
  tripCurrency:        string
  symbol:              string
  items:               FormItem[]
  adjustments:         ExpenseAdjustment[]
  amountMinor:         number
  /** items.sum + signed adjustments (post-adjustment total). */
  effectiveItemsTotal: number
  /** amountMinor − effectiveItemsTotal. */
  itemsDiff:           number
  /** Trip-currency per-line FX preview (null when not foreign / no rate). */
  foreignLinePreview:  ForeignLinePreview | null
  /** Inflight display text for an adjustment amount (typed value else the
   *  formatted minor amount under the effective currency). */
  adjustmentAmountValue: (adj: ExpenseAdjustment) => string
  onAddItem:             () => void
  onRemoveItem:          (index: number) => void
  onSetItemName:         (index: number, value: string) => void
  onSetItemAmount:       (index: number, value: string) => void
  onToggleItemAllocation:    (index: number, memberId: string) => void
  onSetItemAllocationShares: (index: number, memberId: string, shares: number) => void
  onAddAdjustment:       () => void
  onRemoveAdjustment:    (id: string) => void
  onSetAdjustmentLabel:  (id: string, value: string) => void
  onSetAdjustmentAmount: (id: string, value: string) => void
  onSetAdjustmentKind:   (id: string, kind: ExpenseAdjustmentKind) => void
  onSetAdjustmentScope:  (id: string, scope: ExpenseAdjustmentScope, itemIds: string[]) => void
  onSetAdjustmentTarget: (id: string, targetItemId: string) => void
}

export default function LineItemsSection({
  error, members, currency, tripCurrency, symbol,
  items, adjustments, amountMinor, effectiveItemsTotal, itemsDiff,
  foreignLinePreview, adjustmentAmountValue,
  onAddItem, onRemoveItem, onSetItemName, onSetItemAmount, onToggleItemAllocation, onSetItemAllocationShares,
  onAddAdjustment, onRemoveAdjustment, onSetAdjustmentLabel, onSetAdjustmentAmount,
  onSetAdjustmentKind, onSetAdjustmentScope, onSetAdjustmentTarget,
}: LineItemsSectionProps) {
  return (
    <FormField label="明細（為每個項目選擇分攤者）" error={error}>
      <div className="flex flex-col gap-2">
        {/* Single bordered container holding all rows with hairline
            separators (divide-y) instead of each row being its own
            bordered card. Cuts row visual weight by ~25% and reads
            as a unified list — closer to Splitwise / native iOS
            table patterns than the previous "stack of cards". */}
        <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
          {items.map((it, i) => (
            <ExpenseItemRow
              key={it.id}
              index={i}
              item={it}
              members={members}
              currency={currency}
              symbol={symbol}
              tripCurrency={tripCurrency}
              convertedItemAmount={foreignLinePreview?.itemAmountById.get(it.id)}
              onSetName={onSetItemName}
              onSetAmount={onSetItemAmount}
              onToggleAllocation={onToggleItemAllocation}
              onSetAllocationShares={onSetItemAllocationShares}
              onRemove={onRemoveItem}
            />
          ))}
        </div>

        {adjustments.length > 0 && (
          <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
            <div className="px-2.5 py-2 text-[11px] font-semibold text-muted">
              割引・税・調整
            </div>
            {adjustments.map((adj, i) => (
              <ExpenseAdjustmentRow
                key={adj.id}
                index={i}
                adjustment={adj}
                items={items}
                members={members}
                symbol={symbol}
                tripCurrency={tripCurrency}
                amountValue={adjustmentAmountValue(adj)}
                convertedAdjustmentAmount={foreignLinePreview?.adjustmentAmountById.get(adj.id)}
                onSetLabel={onSetAdjustmentLabel}
                onSetAmount={onSetAdjustmentAmount}
                onSetKind={onSetAdjustmentKind}
                onSetScope={onSetAdjustmentScope}
                onSetTarget={onSetAdjustmentTarget}
                onRemove={onRemoveAdjustment}
              />
            ))}
          </div>
        )}

        {/* 「行」と「調整」を同列に並べることで「OCRが拾えなかった
            クーポン/税は手で足せる」というメンタルモデルを明示する。
            Phase Bで負金額itemが封じられた今、ここがズレ補正の唯一の
            正規ルート。 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onAddItem}
            className="flex items-center justify-center gap-1.5 h-9 rounded-input border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Plus size={14} strokeWidth={2} />
            新增明細
          </button>
          <button
            type="button"
            onClick={onAddAdjustment}
            className="flex items-center justify-center gap-1.5 h-9 rounded-input border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Plus size={14} strokeWidth={2} />
            新增調整
          </button>
        </div>

        {/* Sum check — compares the post-adjustment effective total
            to the bill total. Same green/red pattern as カスタム split.
            Small + reads better in place, so it stays inline (not a
            separate row component). */}
        {amountMinor > 0 && (
          <div
            className={[
              'flex justify-between items-center px-2.5 py-1.5 rounded-input text-[11.5px] font-semibold tabular-nums',
              itemsDiff === 0
                ? 'bg-teal-pale text-teal'
                : 'bg-warn-bg text-warn',
            ].join(' ')}
          >
            <span>
              {itemsDiff === 0 ? '✓ 合計一致' : itemsDiff > 0 ? '不足' : '超過'}
            </span>
            <span>
              {formatMinorAmount(effectiveItemsTotal, currency)} / {formatMinorAmount(amountMinor, currency)}
              {itemsDiff !== 0 && (
                <span className="ml-1.5">({itemsDiff > 0 ? '+' : ''}{formatMinorAmount(itemsDiff, currency)})</span>
              )}
            </span>
          </div>
        )}
      </div>
    </FormField>
  )
}
