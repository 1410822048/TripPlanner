// src/components/ui/CurrencyPicker.tsx
// Compact dropdown-style currency picker. Matches the DatePicker visual
// language: an input-shaped trigger that opens a dialog with the
// options as a scrollable list. The grid version this replaced ate
// ~180px of vertical space (5 rows × 3 col); this trigger is the same
// same min-height + line-height contract as the date/text inputs around
// it, keeping the create / edit trip forms visually tight without
// clipping CJK fallback font metrics.

import { useEffect, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import PickerDialog from './pickers/PickerDialog'
import { CURRENCY_OPTIONS, DEFAULT_CURRENCY, type CurrencyMeta } from '@/utils/currency'

interface Props {
  value:    string
  onChange: (code: string) => void
}

export default function CurrencyPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  // Close on Esc handled by PickerDialog itself; we also close after
  // selection below.

  // Pre-compute the selected meta so the trigger has stable text even
  // when `value` is a code we don't have in the registry (legacy data /
  // a future code we haven't added) — degrades gracefully to showing
  // the raw code.
  const selected: CurrencyMeta =
    CURRENCY_OPTIONS.find(c => c.code === value)
    ?? CURRENCY_OPTIONS.find(c => c.code === DEFAULT_CURRENCY)!

  function pick(code: string) {
    onChange(code)
    setOpen(false)
  }

  return (
    <>
      {/* Trigger — matches the .input-shaped components (DatePicker, text
          fields) so the picker reads as a single field in the form rather
          than a competing UI region. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) }
        }}
        className={[
          'w-full min-h-12 rounded-input bg-app px-3 py-2.5 gap-2',
          'flex items-center cursor-pointer',
          'border-[1.5px] border-border transition-colors',
          open ? 'border-accent' : 'hover:border-muted',
        ].join(' ')}
      >
        <span className="text-[14px] font-bold leading-6 text-ink min-w-[28px] tracking-tight">
          {selected.symbol}
        </span>
        <span className="flex-1 text-left text-[14px] leading-6 text-ink tracking-[0.02em] truncate">
          {selected.label}
        </span>
        <ChevronDown
          size={14} strokeWidth={2.2}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </div>

      <PickerDialog isOpen={open} onClose={() => setOpen(false)} title="選擇幣別">
        <CurrencyList value={value} onPick={pick} />
      </PickerDialog>
    </>
  )
}

function CurrencyList({ value, onPick }: { value: string; onPick: (code: string) => void }) {
  // Scroll the active row into view on open so a user with a non-top
  // selection (e.g. AUD, near the end of the list) doesn't have to
  // scroll to confirm what they picked. useEffect because we need the
  // DOM to exist; container ref keyed to the scroll container only.
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!container) return
    const active = container.querySelector<HTMLButtonElement>('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [container])

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-2 text-[12px] font-bold text-muted tracking-[0.08em] uppercase">
        選擇幣別
      </div>
      <div
        ref={setContainer}
        className="thin-scrollbar overflow-y-auto max-h-[60vh] pb-2"
      >
        {CURRENCY_OPTIONS.map(c => {
          const isActive = c.code === value
          return (
            <button
              key={c.code}
              type="button"
              data-active={isActive}
              onClick={() => onPick(c.code)}
              className={[
                'w-full flex items-center gap-3 px-4 py-2.5 cursor-pointer border-none text-left transition-colors',
                isActive ? 'bg-accent-pale' : 'bg-transparent hover:bg-app',
              ].join(' ')}
            >
              <span className={[
                'min-w-[32px] text-[15px] font-bold tracking-tight leading-none',
                isActive ? 'text-accent' : 'text-ink',
              ].join(' ')}>
                {c.symbol}
              </span>
              <span className="flex-1 min-w-0">
                <span className={[
                  'block text-[13.5px] tracking-[0.02em] truncate',
                  isActive ? 'text-accent font-bold' : 'text-ink font-medium',
                ].join(' ')}>
                  {c.label}
                </span>
              </span>
              {isActive && <Check size={15} strokeWidth={2.4} className="text-accent shrink-0" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
