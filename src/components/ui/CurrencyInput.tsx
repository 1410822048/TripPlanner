// src/components/ui/CurrencyInput.tsx
// Number input with a left-aligned currency symbol prefix.
//
// Why a primitive: the previous pattern used absolute-positioned span
// over an input with hard-coded `pl-7` / `pl-6` left padding. That works
// for single-glyph symbols (`¥` / `$` / `€` / `£`) but the registry
// also has 2-3 char symbols (`NT$`, `CN¥`, `HK$`, `S$`, `A$`, `RM`,
// `Rp`) which overflow into the input area — placeholder "0" and the
// symbol read as "NT$0" overlapped.
//
// Flex layout makes the prefix shrink-0 and the input flex-1, so any
// symbol width is accommodated without per-symbol padding tuning. The
// shell carries the border / focus-within state so the prefix + input
// still read as a single styled field.
import type { InputHTMLAttributes } from 'react'

type Size = 'default' | 'compact'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'prefix' | 'size'> {
  /** Currency symbol shown as prefix. Any width — flex layout handles
   *  growth without overlapping the value. */
  symbol: string
  /** Error state — flips the shell border to danger. */
  error?: boolean
  /** Right-align the number (for split rows / tabular columns). */
  alignRight?: boolean
  /** Shell sizing. 'default' = 42px (main form fields), 'compact' = 36px
   *  (row inputs in item / custom-split lists). */
  size?: Size
  /** Optional full override of the shell's outermost classes. Used by
   *  callers needing custom corner radius (e.g. rounded-[8px] for the
   *  item / split rows) without rebuilding the focus / error logic. */
  shellClassName?: string
}

export default function CurrencyInput({
  symbol, error, alignRight, size = 'default', shellClassName,
  className = '', ...rest
}: Props) {
  const sizeShell = size === 'compact' ? 'h-9 px-2.5' : 'h-[42px] px-3'
  const symbolText = size === 'compact' ? 'text-[12px] mr-1' : 'text-[13px] mr-1.5'

  return (
    <div className={[
      'flex items-center w-full min-w-0 bg-app',
      'border-[1.5px] transition-colors',
      'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
      error ? 'border-danger' : 'border-border',
      shellClassName ?? `${sizeShell} rounded-input`,
    ].join(' ')}>
      <span className={`shrink-0 pointer-events-none text-muted whitespace-nowrap ${symbolText}`}>
        {symbol}
      </span>
      <input
        type="number"
        inputMode="numeric"
        className={[
          'flex-1 min-w-0 h-full bg-transparent text-[16px] text-ink outline-none',
          alignRight ? 'text-right tabular-nums' : '',
          className,
        ].filter(Boolean).join(' ')}
        {...rest}
      />
    </div>
  )
}
