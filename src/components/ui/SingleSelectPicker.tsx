import { useEffect, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import PickerDialog from './pickers/PickerDialog'

export interface SingleSelectOption {
  value: string
  prefix: string
  label: string
}

interface Props {
  value: string
  options: readonly SingleSelectOption[]
  title: string
  placeholder: string
  onChange: (value: string) => void
  error?: boolean
  required?: boolean
}

/** 幣別與國家共用的單選控制；所有視覺與互動只維護一份。 */
export default function SingleSelectPicker({
  value,
  options,
  title,
  placeholder,
  onChange,
  error = false,
  required = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)

  function pick(nextValue: string) {
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        aria-label={selected ? `${selected.prefix} ${selected.label}` : placeholder}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={error || undefined}
        aria-required={required || undefined}
        onClick={() => setOpen(true)}
        className={[
          'w-full min-h-12 rounded-input bg-app px-3 py-2.5 gap-2',
          'flex items-center cursor-pointer',
          'border-[1.5px] transition-colors',
          error ? 'border-danger' : open ? 'border-accent' : 'border-border hover:border-muted',
        ].join(' ')}
      >
        <span className="min-w-[32px] text-left text-[14px] font-bold leading-6 text-ink tracking-tight">
          {selected?.prefix ?? (value || '—')}
        </span>
        <span className={`flex-1 truncate text-left text-[14px] leading-6 tracking-[0.02em] ${selected ? 'text-ink' : 'text-muted'}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2.2}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <PickerDialog isOpen={open} onClose={() => setOpen(false)} title={title}>
        <OptionList title={title} value={value} options={options} onPick={pick} />
      </PickerDialog>
    </>
  )
}

function OptionList({
  title,
  value,
  options,
  onPick,
}: {
  title: string
  value: string
  options: readonly SingleSelectOption[]
  onPick: (value: string) => void
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!container) return
    container.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [container])

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-4 pb-2 text-[12px] font-bold text-muted tracking-[0.08em] uppercase">
        {title}
      </div>
      <div
        ref={setContainer}
        role="listbox"
        aria-label={title}
        className="thin-scrollbar max-h-[60vh] overflow-y-auto pb-2"
      >
        {options.map(option => {
          const active = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-label={`${option.prefix} ${option.label}`}
              aria-selected={active}
              onClick={() => onPick(option.value)}
              className={[
                'w-full flex items-center gap-3 px-4 py-2.5 cursor-pointer border-none text-left transition-colors',
                active ? 'bg-accent-pale' : 'bg-transparent hover:bg-app',
              ].join(' ')}
            >
              <span className={[
                'min-w-[32px] text-[15px] font-bold tracking-tight leading-none',
                active ? 'text-accent' : 'text-ink',
              ].join(' ')}>
                {option.prefix}
              </span>
              <span className={[
                'flex-1 min-w-0 truncate text-[13.5px] tracking-[0.02em]',
                active ? 'text-accent font-bold' : 'text-ink font-medium',
              ].join(' ')}>
                {option.label}
              </span>
              {active ? <Check size={15} strokeWidth={2.4} className="shrink-0 text-accent" /> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
