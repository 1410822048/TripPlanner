// src/features/expense/components/expenseForm/LineItemsSection.tsx
// Pure presentational section for the by-item「明細」 domain — receipt item
// rows, adjustment rows (割引/税/調整), the add-row/add-adjustment buttons,
// the foreign per-line ≈ preview, and the sum-check banner. Rendered instead
// of SplitsSection when items.length > 0.
//
// Items + adjustments are deliberately ONE section, not two: they share the
// item list (ITEM-scope adjustments target a row), the foreign preview map,
// and the sum check. Splitting them would force the adjustment half to take
// the item list + preview + diff as props anyway, scattering them worse.
//
// Split out of ExpenseFormModal (item 4). All state / hooks / derived math
// stay in the modal; this component only renders + calls back. It does NOT
// import useExpenseItems / useExpenseMoneyDraft — the modal hands in the
// already-derived values and the individual handlers.
import { Plus, Trash2 } from 'lucide-react'
import {
  EXPENSE_ADJUSTMENT_KINDS,
  type ExpenseAdjustment,
  type ExpenseAdjustmentKind,
  type ExpenseAdjustmentScope,
} from '@/types'
import { adjustmentSign } from '@tripmate/expense-materialize'
import FormField from '@/components/ui/FormField'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberChip from '@/components/ui/MemberChip'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { compactInputClass } from '@/components/ui/inputStyle'
import { formatMinorAmount } from '@/utils/money'
import type { TripMember } from '@/features/trips/types'
import type { FormItem } from '../../hooks/useExpenseItems'
import type { ForeignLinePreview } from '../../services/buildForeignLinePreview'

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
  onToggleItemAssignee:  (index: number, memberId: string) => void
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
  onAddItem, onRemoveItem, onSetItemName, onSetItemAmount, onToggleItemAssignee,
  onAddAdjustment, onRemoveAdjustment, onSetAdjustmentLabel, onSetAdjustmentAmount,
  onSetAdjustmentKind, onSetAdjustmentScope, onSetAdjustmentTarget,
}: LineItemsSectionProps) {
  return (
    <FormField label="明細（各項目に分担者を選択）" error={error}>
      <div className="flex flex-col gap-2">
        {/* Single bordered container holding all rows with hairline
            separators (divide-y) instead of each row being its own
            bordered card. Cuts row visual weight by ~25% and reads
            as a unified list — closer to Splitwise / native iOS
            table patterns than the previous "stack of cards". */}
        <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
          {items.map((it, i) => {
            const convertedItemAmount = foreignLinePreview?.itemAmountById.get(it.id)
            return (
            <div key={it.id} className="flex flex-col gap-1.5 px-2.5 py-2.5">
              {/* Row 1: name + amount. Amount widened to 120px (was 100px)
                  so 5-digit JPY values like ¥10,000 fit without clipping.
                  Removed delete button from this row — it was crowding
                  both inputs. Delete moved to row 2's trailing edge. */}
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
                {/* Font-size MUST be 16px or larger — iOS Safari auto-zooms
                    the viewport on focus of any input below 16px. Keep
                    compact rows descender-safe with explicit leading/padding. */}
                <input
                  value={it.name}
                  onChange={e => onSetItemName(i, e.target.value)}
                  placeholder="項目名"
                  className={compactInputClass(false)}
                />
                <div className="min-w-0">
                  <CurrencyInput
                    symbol={symbol}
                    size="compact"
                    alignRight
                    shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
                    value={it.amountText}
                    onChange={e => onSetItemAmount(i, e.target.value)}
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
                      active={it.assignees.includes(m.id)}
                      onClick={() => onToggleItemAssignee(i, m.id)}
                      size="sm"
                    />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveItem(i)}
                  aria-label={`行 ${i + 1} を削除`}
                  className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
                >
                  <Trash2 size={13} strokeWidth={2} />
                </button>
              </div>
            </div>
            )
          })}
        </div>

        {adjustments.length > 0 && (
          <div className="rounded-input border border-border bg-surface overflow-hidden divide-y divide-border">
            <div className="px-2.5 py-2 text-[11px] font-semibold text-muted">
              割引・税・調整
            </div>
            {adjustments.map((adj, i) => {
              const sign = adjustmentSign(adj.kind)
              const convertedAdjustmentAmount = foreignLinePreview?.adjustmentAmountById.get(adj.id)
              // UX B — who this adjustment hits: 全体 for EXPENSE scope,
              // the target item + its assignees for ITEM scope. Makes
              // 「クーポン −¥30」legible (扣哪個項目 / 影響誰).
              const targetItem = adj.scope === 'ITEM'
                ? items.find(it => it.id === adj.targetItemId)
                : undefined
              const targetAssignees = targetItem
                ? members.filter(m => targetItem.assignees.includes(m.id))
                : []
              return (
                <div key={adj.id} className="flex flex-col gap-2 px-2.5 py-2.5">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(112px,38%)] items-start gap-2">
                    <input
                      value={adj.label}
                      onChange={e => onSetAdjustmentLabel(adj.id, e.target.value)}
                      placeholder={`調整 ${i + 1}`}
                      aria-label={`調整 ${i + 1} ラベル`}
                      className={compactInputClass(false)}
                    />
                    <div className="min-w-0">
                      <CurrencyInput
                        symbol={`${sign < 0 ? '-' : '+'}${symbol}`}
                        size="compact"
                        alignRight
                        shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
                        value={adjustmentAmountValue(adj)}
                        onChange={e => onSetAdjustmentAmount(adj.id, e.target.value)}
                        placeholder="0"
                        aria-label={`調整 ${i + 1} 金額`}
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
                      onChange={e => onSetAdjustmentKind(adj.id, e.target.value as ExpenseAdjustmentKind)}
                      aria-label={`調整 ${i + 1} 種類`}
                      className={compactInputClass(false)}
                    >
                      {EXPENSE_ADJUSTMENT_KINDS.map(kind => (
                        <option key={kind} value={kind}>{ADJUSTMENT_KIND_LABEL[kind]}</option>
                      ))}
                    </select>

                    <select
                      value={adj.scope}
                      onChange={e => onSetAdjustmentScope(adj.id, e.target.value as ExpenseAdjustmentScope, items.map(it => it.id))}
                      aria-label={`調整 ${i + 1} 対象範囲`}
                      className={compactInputClass(false)}
                    >
                      {ADJUSTMENT_SCOPE_OPTIONS.map(scope => (
                        <option key={scope.value} value={scope.value}>{scope.label}</option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() => onRemoveAdjustment(adj.id)}
                      aria-label={`調整 ${i + 1} を削除`}
                      className="w-7 h-7 rounded-full flex items-center justify-center bg-transparent text-muted border-none cursor-pointer hover:text-warn transition-colors shrink-0"
                    >
                      <Trash2 size={13} strokeWidth={2} />
                    </button>
                  </div>

                  {adj.scope === 'ITEM' && (
                    <select
                      value={adj.targetItemId ?? ''}
                      onChange={e => onSetAdjustmentTarget(adj.id, e.target.value)}
                      aria-label={`調整 ${i + 1} 対象項目`}
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

                  {/* UX B — 「誰に効くか」 summary. EXPENSE = 全体; ITEM =
                      target item name + its assignee avatars. */}
                  {adj.scope === 'EXPENSE' ? (
                    <div className="text-[10.5px] text-muted">対象: 全体</div>
                  ) : targetItem ? (
                    <div className="flex items-center gap-1.5 text-[10.5px] text-muted min-w-0">
                      <span className="shrink-0">対象:</span>
                      <span className="truncate font-medium text-ink">
                        {targetItem.name.trim() || '項目'}
                      </span>
                      {targetAssignees.length > 0 && (
                        <span className="flex items-center gap-0.5 shrink-0">
                          {targetAssignees.map(m => (
                            <MemberAvatar key={m.id} member={m} size={16} />
                          ))}
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
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
            行を追加
          </button>
          <button
            type="button"
            onClick={onAddAdjustment}
            className="flex items-center justify-center gap-1.5 h-9 rounded-input border-[1.5px] border-dashed border-border bg-transparent text-muted text-[12px] font-medium cursor-pointer hover:border-accent hover:text-accent transition-colors"
          >
            <Plus size={14} strokeWidth={2} />
            調整を追加
          </button>
        </div>

        {/* Sum check — compares the post-adjustment effective total
            to the bill total. Same green/red pattern as カスタム split. */}
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
