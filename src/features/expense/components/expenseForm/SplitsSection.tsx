// src/features/expense/components/expenseForm/SplitsSection.tsx
// Pure presentational section for the 「割り勘」 manual-split UI — the
// 均等 / カスタム tabs + per-member rows + custom-sum check. Rendered when
// there are no receipt items. Split out of ExpenseFormModal (item 3);
// useSplitsState + the derived split math stay in the modal.
import FormField from '@/components/ui/FormField'
import CurrencyInput from '@/components/ui/CurrencyInput'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { formatMinorAmount } from '@/utils/money'
import type { SplitMode } from '../../hooks/useSplitsState'
import type { TripMember } from '@/features/trips/types'

interface SplitsSectionProps {
  error:        string | undefined
  mode:         SplitMode
  members:      TripMember[]
  /** Member ids included in the equal split. */
  included:     Set<string>
  /** Per-member custom-amount input text. */
  custom:       Record<string, string>
  symbol:       string
  currency:     string
  amountMinor:  number
  /** Per-member equal-split amounts (minor units). */
  equalSplits:  Record<string, number>
  /** Reparsed custom amount for a member (minor units). */
  customAmountOf: (id: string) => number
  customSum:    number
  customDiff:   number
  onSwitchMode:     (mode: SplitMode) => void
  onToggleIncluded: (id: string) => void
  onSetCustom:      (id: string, value: string) => void
}

export default function SplitsSection({
  error, mode, members, included, custom, symbol, currency, amountMinor,
  equalSplits, customAmountOf, customSum, customDiff,
  onSwitchMode, onToggleIncluded, onSetCustom,
}: SplitsSectionProps) {
  return (
    <FormField label="割り勘" error={error}>
      <div className="flex flex-col gap-2">
        {/* 割勘方式切換 */}
        <div className="flex gap-1 p-1 rounded-card bg-app border border-border">
          {([
            { value: 'equal',  label: '均等' },
            { value: 'custom', label: 'カスタム' },
          ] as const).map(m => {
            const active = mode === m.value
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => onSwitchMode(m.value)}
                className={[
                  'flex-1 h-8 rounded-[8px] text-[12px] font-semibold cursor-pointer transition-all',
                  active ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.08)]' : 'bg-transparent text-muted',
                ].join(' ')}
              >
                {m.label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          {members.map(m => {
            const isIncluded = mode === 'equal'
              ? included.has(m.id)
              : customAmountOf(m.id) > 0
            const displayAmount = mode === 'equal'
              ? (equalSplits[m.id] ?? 0)
              : customAmountOf(m.id)

            return (
              <div
                key={m.id}
                className={[
                  'flex items-center gap-2.5 px-2.5 py-1.5 rounded-input border-[1.5px] transition-colors',
                  isIncluded ? 'border-border bg-surface' : 'border-border bg-app opacity-55',
                ].join(' ')}
              >
                <MemberAvatar member={m} size={28} />
                <span className="flex-1 text-[13px] text-ink font-medium">{m.label}</span>

                {mode === 'equal' ? (
                  <>
                    <span className="text-[13px] font-semibold text-ink tabular-nums">
                      {isIncluded ? formatMinorAmount(displayAmount, currency) : '—'}
                    </span>
                    <input
                      type="checkbox"
                      checked={isIncluded}
                      onChange={() => onToggleIncluded(m.id)}
                      className="w-4 h-4 accent-accent cursor-pointer"
                    />
                  </>
                ) : (
                  <div className="w-[110px]">
                    <CurrencyInput
                      symbol={symbol}
                      size="compact"
                      alignRight
                      shellClassName="min-h-10 px-2.5 py-1.5 rounded-[8px]"
                      value={custom[m.id] ?? ''}
                      onChange={e => onSetCustom(m.id, e.target.value)}
                      placeholder="0"
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {mode === 'custom' && amountMinor > 0 && (
          <div
            className={[
              'flex justify-between items-center px-2.5 py-1.5 rounded-input text-[11.5px] font-semibold tabular-nums',
              customDiff === 0
                ? 'bg-teal-pale text-teal'
                : 'bg-warn-bg text-warn',
            ].join(' ')}
          >
            <span>
              {customDiff === 0 ? '✓ 總和一致' : customDiff > 0 ? '残り' : '超過'}
            </span>
            <span>
              {formatMinorAmount(customSum, currency)} / {formatMinorAmount(amountMinor, currency)}
              {customDiff !== 0 && (
                <span className="ml-1.5">({customDiff > 0 ? '+' : ''}{formatMinorAmount(customDiff, currency)})</span>
              )}
            </span>
          </div>
        )}
      </div>
    </FormField>
  )
}
