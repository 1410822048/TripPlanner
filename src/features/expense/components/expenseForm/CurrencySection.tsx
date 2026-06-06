// src/features/expense/components/expenseForm/CurrencySection.tsx
// Pure presentational section for the money-input region: the foreign-mode
// toggle, the source-currency picker, the 金額 + 日付 row, and the inline FX
// preview banner. Split out of ExpenseFormModal (item 3). All money STATE
// (useExpenseMoneyDraft / useFxPreview) stays in the modal; this renders.
import { Globe, Loader2 } from 'lucide-react'
import FormField from '@/components/ui/FormField'
import CurrencyInput from '@/components/ui/CurrencyInput'
import CurrencyPicker from '@/components/ui/CurrencyPicker'
import { DatePicker } from '@/components/ui/pickers'
import { formatMinorAmount } from '@/utils/money'
import type { FxPreviewResult } from '@/hooks/useFxPreview'

interface CurrencySectionProps {
  isForeignOpen:       boolean
  sourceCurrency:      string
  tripCurrency:        string
  lastForeignCurrency: string
  /** Symbol of the effective (source when foreign) currency. */
  symbol:              string
  amountText:          string
  /** Parsed source-currency minor amount — drives the FX preview line. */
  amountMinor:         number
  amountError:         string | undefined
  date:                string
  dateError:           string | undefined
  fx:                  FxPreviewResult
  /** Trip-currency preview of the source amount (null = not foreign / no
   *  rate / no amount yet). */
  previewConvertedMinor: number | null
  onSwitchCurrency:    (next: string) => void
  onAmountChange:      (value: string) => void
  onDateChange:        (value: string) => void
}

export default function CurrencySection({
  isForeignOpen, sourceCurrency, tripCurrency, lastForeignCurrency,
  symbol, amountText, amountMinor, amountError, date, dateError,
  fx, previewConvertedMinor, onSwitchCurrency, onAmountChange, onDateChange,
}: CurrencySectionProps) {
  return (
    <>
      {/* Phase 3c-1 — foreign-mode toggle. Always-visible full-row button
          (≥48px tap target) above the amount field so it reads as "the
          currency for the next row" rather than a buried setting. The
          section below is conditionally rendered (not just visually
          hidden) so aria-expanded ↔ presence stays in sync for AT users.
          State of truth lives in `sourceCurrency` — toggling here
          flips it between trip-currency (degenerate / closed) and
          the remembered foreign code. Picking trip-currency inside the
          picker also collapses the section, giving two equivalent exits. */}
      <button
        type="button"
        onClick={() => onSwitchCurrency(
          isForeignOpen ? tripCurrency : lastForeignCurrency,
        )}
        aria-expanded={isForeignOpen}
        aria-controls="foreign-currency-fields"
        className={[
          'w-full min-h-12 px-3 rounded-input border-[1.5px] text-[13px] font-semibold',
          'flex items-center justify-between gap-2 cursor-pointer transition-colors',
          isForeignOpen
            ? 'border-accent bg-accent-pale text-accent'
            : 'border-border bg-app text-muted hover:border-accent hover:text-accent',
        ].join(' ')}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Globe size={14} strokeWidth={2} className="shrink-0" />
          <span className="truncate">
            {isForeignOpen ? `${tripCurrency}で入力に戻す` : '別の通貨で入力'}
          </span>
        </span>
        {isForeignOpen && (
          <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums opacity-80">
            {sourceCurrency} → {tripCurrency}
          </span>
        )}
      </button>

      {isForeignOpen && (
        <section id="foreign-currency-fields" className="flex flex-col gap-2">
          <FormField label="入力する通貨">
            <CurrencyPicker
              value={sourceCurrency}
              onChange={onSwitchCurrency}
            />
            <p className="text-[11px] leading-relaxed text-muted">
              入力した金額を{tripCurrency}に換算して保存します
            </p>
          </FormField>
        </section>
      )}

      <div className="flex gap-2.5">
        <FormField label={`金額（${symbol}）`} error={amountError} required className="flex-1">
          <CurrencyInput
            symbol={symbol}
            value={amountText}
            onChange={e => onAmountChange(e.target.value)}
            placeholder="0"
            error={!!amountError}
          />
        </FormField>
        <FormField label="日付" error={dateError} required className="flex-1">
          <DatePicker value={date} onChange={onDateChange} error={!!dateError} />
        </FormField>
      </div>

      {/* Phase 3c-1 — inline FX preview. Four render states:
          - loading:  spinner + "rate will be finalized on save"
          - error:    neutral "Worker will retry on save" copy
          - blocked:  future/invalid inputs that Worker would also reject
          - success:  「{source} → {trip} @ {rate} ({rateDate})」 with both
                      sides rendered via the canonical money formatter so
                      symbols / fraction digits match the rest of the form.
          Only renders when foreign-open; same-currency keeps the form
          layout unchanged. */}
      {isForeignOpen && (
        <div
          role="status"
          aria-live="polite"
          className={[
            'flex items-center gap-2 px-3 py-2 rounded-input text-[12px] font-medium',
            // Warn for terminal "no rate" states — submit will be
            // blocked by the buildExpenseFormResult FX gate, so the banner must
            // read as actionable. Loading stays teal-pale (transient,
            // shows a spinner) so it doesn't masquerade as an error.
            fx.disabledReason || fx.isError
              ? 'bg-warn-bg text-warn border border-warn'
              : 'bg-teal-pale text-teal',
          ].join(' ')}
        >
          {fx.disabledReason === 'future-date' ? (
            <span>未来日付は換算できません。日付を変更してください。</span>
          ) : fx.disabledReason === 'invalid-input' ? (
            <span>通貨または日付を確認してください。</span>
          ) : fx.isLoading ? (
            <>
              <Loader2 size={14} strokeWidth={2.2} className="animate-spin shrink-0" />
              <span>換算レートを取得中…</span>
            </>
          ) : fx.isError || !fx.rateDecimal ? (
            <span>換算レートを取得できません。再試行してください。</span>
          ) : previewConvertedMinor !== null ? (
            <div className="flex-1 min-w-0 flex flex-col gap-1 tabular-nums sm:flex-row sm:items-baseline sm:justify-between">
              <span className="min-w-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-5">
                <span>{formatMinorAmount(amountMinor, sourceCurrency)}</span>
                <span className="opacity-60">→</span>
                <span className="font-semibold">
                  {formatMinorAmount(previewConvertedMinor, tripCurrency)}
                </span>
              </span>
              <span className="shrink-0 whitespace-nowrap text-[10.5px] opacity-75">
                @ {fx.rateDecimal} ({fx.rateDate})
              </span>
            </div>
          ) : (
            <span>レート {fx.rateDecimal}（{fx.rateDate}）— 金額を入力してください</span>
          )}
        </div>
      )}
    </>
  )
}
