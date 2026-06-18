// src/features/schedule/components/TimelineCard.tsx
import { Clock, MapPin } from 'lucide-react'
import type { Schedule } from '@/types'
import { mapsSearchUrl } from '@/utils/maps'
import { formatMinorAmount } from '@/utils/money'
import { CATEGORY_ICON, SCHEDULE_CATEGORY_STYLE } from '@/shared/categoryMeta'

interface Props {
  s:        Schedule
  isLast:   boolean
  currency: string
  onOpenDetails: () => void
}

export default function TimelineCard({ s, isLast, currency, onOpenDetails }: Props) {
  const cat  = SCHEDULE_CATEGORY_STYLE[s.category]
  const Icon = CATEGORY_ICON[s.category]
  // Inline maps link on the location label — keeps the meta row to one
  // line instead of stacking a separate chip below (which thickened the
  // timeline noticeably across many cards). The whole pin + name is the
  // tap target; stopPropagation peels the click off the parent so it
  // doesn't double-fire as tap-to-edit.
  const locationName = s.location?.name
  const mapHref      = locationName ? mapsSearchUrl(locationName) : null

  // role="button" + keyboard handler instead of a real <button>: an
  // <a> can't nest inside <button> per HTML spec, and we need the
  // location anchor to live in the same tap-to-edit region. The
  // tabIndex + Enter/Space handler restore the keyboard semantics
  // we'd lose by switching off <button>.
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpenDetails()
    }
  }

  return (
    <div className={[
      'relative pl-4',
      isLast ? 'pb-0' : 'pb-4',
    ].join(' ')}>
      <div
        className={[
          'absolute left-[13px] top-0 w-[1.5px]',
          isLast ? 'h-[18px]' : 'bottom-0',
        ].join(' ')}
        style={{
          background: `repeating-linear-gradient(to bottom, var(--color-dot) 0, var(--color-dot) 3px, transparent 3px, transparent 7px)`,
        }}
      />
      <div
        className="absolute left-0 top-1 z-10 w-[28px] h-[28px] rounded-full border-[2px] border-app flex items-center justify-center shadow-[0_2px_8px_rgba(32,42,45,0.08)]"
        style={{ background: cat.bg, color: cat.color }}
      >
        <Icon size={14} strokeWidth={2} />
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={onOpenDetails}
        onKeyDown={handleKeyDown}
        aria-label={`${s.title} の詳細を表示`}
        className={[
          'relative ml-2.5 flex min-h-[92px] items-center gap-2 bg-surface border border-border rounded-[20px] pl-4 pr-3 py-3',
          'cursor-pointer transition-colors',
          'hover:bg-[#F5F1EA] focus-visible:outline-2 focus-visible:outline-accent',
        ].join(' ')}
        style={{
          WebkitTapHighlightColor: 'transparent',
          borderLeftColor: cat.color,
          borderLeftWidth: 4,
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px] text-muted min-w-0 pt-0.5">
              {s.startTime && (
                <span className="flex items-center gap-[3px] shrink-0">
                  <Clock size={10} strokeWidth={2} />
                  {s.startTime}{s.endTime ? ` — ${s.endTime}` : ''}
                </span>
              )}
              {locationName && (
                mapHref ? (
                  <a
                    href={mapHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={e => e.stopPropagation()}
                    onPointerDown={e => e.stopPropagation()}
                    onKeyDown={e => e.stopPropagation()}
                    aria-label={`${locationName} を地図で開く`}
                    className="flex min-w-0 items-center gap-[3px] text-accent no-underline hover:underline"
                  >
                    <MapPin size={10} strokeWidth={2} className="shrink-0" />
                    <span className="truncate">{locationName}</span>
                  </a>
                ) : (
                  <span className="flex min-w-0 items-center gap-[3px] text-muted">
                    <MapPin size={10} strokeWidth={2} className="shrink-0" />
                    <span className="truncate">{locationName}</span>
                  </span>
                )
              )}
            </div>
            {typeof s.estimatedCostMinor === 'number' && s.estimatedCostMinor > 0 && (
              <span
                className="text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0 whitespace-nowrap tabular-nums leading-none"
                style={{ color: cat.color, background: cat.bg }}
              >
                {formatMinorAmount(s.estimatedCostMinor, currency)}
              </span>
            )}
          </div>
          <div className="mt-1.5">
            <span className="text-[14px] font-semibold text-ink leading-[1.3] break-words">
              {s.title}
            </span>
          </div>
          {s.description && (
            <span className="block mt-3 border-t border-border pt-3 text-[11.5px] text-[#AEA9A2] leading-[1.55]">
              {s.description}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
