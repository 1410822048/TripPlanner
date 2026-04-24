// src/features/account/components/StatCell.tsx
// Horizontal stat cell — centered number on top, quiet label underneath.
// Sits inside a `flex divide-x` row so cells share vertical dividers and
// equal width via flex-1. `rawValue` is used when the value isn't numeric
// (e.g., `2 年` for account age, which carries its own unit).
interface Props {
  label:     string
  value?:    number
  unit?:     string
  rawValue?: string
}

export default function StatCell({ label, value, unit, rawValue }: Props) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-2">
      <div className="flex items-baseline gap-0.5 leading-none">
        <span className="text-[22px] font-black text-ink -tracking-[0.3px]">
          {rawValue ?? value}
        </span>
        {unit && (
          <span className="text-[11px] font-semibold text-muted">
            {unit}
          </span>
        )}
      </div>
      <div className="text-[10.5px] text-muted tracking-[0.04em] mt-1.5">
        {label}
      </div>
    </div>
  )
}
