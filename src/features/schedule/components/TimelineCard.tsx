// src/features/schedule/components/TimelineCard.tsx
import { Clock, MapPin, Pencil } from 'lucide-react'
import type { Schedule, ScheduleCategory } from '@/types'
import { mapsSearchUrl } from '@/utils/maps'
import { formatMinorAmount } from '@/utils/money'
import { CATEGORY_ICON } from '@/shared/categoryMeta'

// 色だけローカル(タイムラインの淡色トーン)。アイコンは shared の CATEGORY_ICON
// を single source にして、フォーム picker / 費用リストと食い違わないようにする。
const CAT_STYLE: Record<ScheduleCategory, { bg: string; color: string }> = {
  transport:     { bg:'#E8EEF5', color:'#4A6FA0' },
  accommodation: { bg:'#F5EDE6', color:'#9A6840' },
  food:          { bg:'#F5E8E8', color:'#9A4848' },
  activity:      { bg:'#E6F2EC', color:'#3A7858' },
  shopping:      { bg:'#F0E8F5', color:'#724888' },
  other:         { bg:'#EBEBEB', color:'#707070' },
}

interface Props {
  s:        Schedule
  isLast:   boolean
  currency: string
  onEdit:   () => void
}

export default function TimelineCard({ s, isLast, currency, onEdit }: Props) {
  const cat  = CAT_STYLE[s.category]
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
      onEdit()
    }
  }

  return (
    <div className={[
      'flex items-stretch',
      isLast ? 'mb-0' : 'mb-2.5',
    ].join(' ')}>
      <div className="flex flex-col items-center w-12 shrink-0">
        <div
          className="w-[34px] h-[34px] rounded-input flex items-center justify-center shrink-0"
          style={{ background: cat.bg, color: cat.color }}
        >
          <Icon size={15} strokeWidth={2} />
        </div>
        {!isLast && (
          <div
            className="w-[1.5px] flex-1 min-h-3 mt-1"
            style={{
              background: `repeating-linear-gradient(to bottom, var(--color-dot) 0, var(--color-dot) 3px, transparent 3px, transparent 7px)`,
            }}
          />
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={onEdit}
        onKeyDown={handleKeyDown}
        aria-label={`${s.title} を編集`}
        className={[
          'flex-1 flex items-center gap-2 bg-surface border border-border rounded-chip px-3.5 py-[11px] pr-3',
          'cursor-pointer transition-colors',
          'hover:bg-[#F5F1EA] focus-visible:outline-2 focus-visible:outline-accent',
        ].join(' ')}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start gap-2">
            <span className="text-[14px] font-semibold text-ink leading-[1.3]">
              {s.title}
            </span>
            {typeof s.estimatedCostMinor === 'number' && s.estimatedCostMinor > 0 && (
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded-card shrink-0 whitespace-nowrap tabular-nums"
                style={{ color: cat.color, background: cat.bg }}
              >
                {formatMinorAmount(s.estimatedCostMinor, currency)}
              </span>
            )}
          </div>
          <div className="flex gap-2.5 mt-[5px] flex-wrap">
            {s.startTime && (
              <span className="flex items-center gap-[3px] text-[11px] text-muted">
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
                  className="flex items-center gap-[3px] text-[11px] text-accent no-underline hover:underline"
                >
                  <MapPin size={10} strokeWidth={2} />
                  {locationName}
                </a>
              ) : (
                <span className="flex items-center gap-[3px] text-[11px] text-muted">
                  <MapPin size={10} strokeWidth={2} />
                  {locationName}
                </span>
              )
            )}
          </div>
          {s.description && (
            <span className="block mt-[5px] text-[11.5px] text-[#AEA9A2] leading-[1.55]">
              {s.description}
            </span>
          )}
        </div>
        <Pencil size={12} color="#CCC8C0" strokeWidth={1.8} className="shrink-0" />
      </div>
    </div>
  )
}
