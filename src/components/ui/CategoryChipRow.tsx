import type { LucideIcon } from 'lucide-react'

interface CategoryChipRowProps<T extends string> {
  categories: readonly { value: T; label: string }[]
  icons: Record<T, LucideIcon>
  active: T
  onSelect: (value: T) => void
}

const ROW_CLASS = 'gap-[7px]'
const BUTTON_CLASS = 'gap-[5px] px-3 py-1.5 text-[12px]'

export default function CategoryChipRow<T extends string>({
  categories, icons, active, onSelect,
}: CategoryChipRowProps<T>) {
  return (
    <div className="-mx-5 overflow-x-auto px-5 no-scrollbar">
      <div className={`flex w-max ${ROW_CLASS}`}>
        {categories.map(c => {
          const Icon: LucideIcon = icons[c.value]
          const isActive = active === c.value

          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelect(c.value)}
              className={[
                'flex shrink-0 items-center whitespace-nowrap rounded-card border-[1.5px] cursor-pointer transition-all',
                BUTTON_CLASS,
                isActive
                  ? 'border-accent bg-accent text-white font-semibold'
                  : 'border-border bg-transparent text-muted font-normal hover:border-muted',
              ].join(' ')}
            >
              <Icon size={13} strokeWidth={2} />{c.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
