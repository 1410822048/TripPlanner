// Shared header band for ticket-style booking cards (Flight / Train,
// and any future transport type). Paints the brand color across the
// top of the card with the brand chip + provider name on the left.
// Right-slot is caller-supplied so each card supplies its own trailing
// label (`BOARDING` + plane icon for flights, `TICKET` for trains).
import type { ReactNode } from 'react'
import type { Brand } from './brandMeta'

interface Props {
  brand:    Brand
  provider: string | undefined
  /** Right-aligned trailing slot -- typically a short label and/or icon. */
  children: ReactNode
}

export default function BrandBand({ brand, provider, children }: Props) {
  return (
    <div
      className="flex items-center justify-between px-3 h-7 text-[10.5px] font-bold tracking-[0.05em]"
      style={{ background: brand.bg, color: brand.fg }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="px-1.5 py-px rounded-sm bg-black/15 text-[10px] tracking-[0.06em] shrink-0">
          {brand.label}
        </span>
        <span className="truncate opacity-90">{provider ?? brand.name}</span>
      </div>
      <span className="flex items-center gap-1 shrink-0 opacity-90">
        {children}
      </span>
    </div>
  )
}
