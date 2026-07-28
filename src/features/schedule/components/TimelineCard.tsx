// src/features/schedule/components/TimelineCard.tsx
import { FileText, MapPin, SquarePen } from 'lucide-react'
import type { Schedule } from '@/types'
import { scheduleLocationName } from '@/types/schedule'
import { effectiveEndTime } from '../routeModel'
import { mapsSearchUrl } from '@/utils/maps'
import { formatMinorAmount } from '@/utils/money'
import {
  CATEGORY_ICON,
  SCHEDULE_CATEGORY_LABEL,
  SCHEDULE_CATEGORY_STYLE,
} from '@/shared/categoryMeta'

interface Props {
  s:        Schedule
  isLast:   boolean
  currency: string
  onOpenDetails: () => void
}

export default function TimelineCard({ s, isLast, currency, onOpenDetails }: Props) {
  const cat  = SCHEDULE_CATEGORY_STYLE[s.category]
  const Icon = CATEGORY_ICON[s.category]
  // 地點列本身就是 Maps 連結；阻止事件冒泡，避免同時觸發卡片詳情。
  const locationName = scheduleLocationName(s.location)
  const displayStartTime = s.startTime
  const displayEndTime = effectiveEndTime(s)
  const displayTime = displayStartTime
    ? `${displayStartTime}${displayEndTime ? ` – ${displayEndTime}` : ''}`
    : '時間未定'
  const mapHref = locationName ? mapsSearchUrl(locationName) : null

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
      isLast ? 'pb-0' : 'pb-2',
    ].join(' ')}>
      <div
        className={[
          'absolute left-[15px] top-0 w-[1.5px]',
          isLast ? 'h-[18px]' : 'bottom-0',
        ].join(' ')}
        style={{ background: 'var(--color-dot)' }}
      />
      <div
        className="absolute left-0 top-0.5 z-10 w-8 h-8 rounded-[11px] border-[2px] border-app flex items-center justify-center shadow-[0_2px_8px_rgba(32,42,45,0.08)]"
        style={{ background: cat.bg, color: cat.color }}
      >
        <Icon size={15} strokeWidth={2} aria-hidden="true" />
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={onOpenDetails}
        onKeyDown={handleKeyDown}
        aria-label={`顯示 ${s.title} 的詳細資料`}
        className={[
          'relative ml-3 min-h-[104px] bg-surface border border-border rounded-[20px] px-3.5 py-3',
          'cursor-pointer transition-colors',
          'hover:bg-[#F5F1EA] focus-visible:outline-2 focus-visible:outline-accent',
        ].join(' ')}
        style={{
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <div className={`-mx-3.5 -mt-3 flex min-w-0 flex-wrap items-center gap-1 px-3.5 pb-2.5 pt-3 ${s.description ? 'pr-[82px]' : ''}`}>
          <span className={`inline-flex min-h-6 items-center rounded-[8px] px-1.5 text-[10.5px] font-bold tabular-nums ${
            displayStartTime ? 'bg-teal-pale text-teal' : 'bg-app text-muted'
          }`}>
            {displayTime}
          </span>
          <span className="inline-flex min-h-6 items-center rounded-[8px] border border-border bg-app px-1.5 text-[10.5px] font-semibold text-muted tabular-nums">
            停留 {s.durationMinutes} 分
          </span>
        </div>

        <h3 className="mt-2.5 mb-0 text-[14px] font-bold leading-[1.35] text-ink break-words">
          {s.title}
        </h3>

        {locationName && (
          mapHref ? (
            <a
              href={mapHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              onPointerDown={e => e.stopPropagation()}
              onKeyDown={e => e.stopPropagation()}
              aria-label={`在地圖中開啟 ${locationName}`}
              className="mt-1.5 inline-flex min-h-6 max-w-full min-w-0 items-center gap-1 text-[11px] text-muted no-underline hover:text-accent hover:underline"
            >
              <MapPin size={11} strokeWidth={2} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{locationName}</span>
            </a>
          ) : (
            <span className="mt-1.5 inline-flex min-h-6 max-w-full min-w-0 items-center gap-1 text-[11px] text-muted">
              <MapPin size={11} strokeWidth={2} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{locationName}</span>
            </span>
          )
        )}

        <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className="inline-flex min-h-6 items-center rounded-[8px] px-2 text-[10.5px] font-bold"
            style={{ color: cat.color, background: cat.bg }}
          >
            {SCHEDULE_CATEGORY_LABEL[s.category]}
          </span>
          {typeof s.estimatedCostMinor === 'number' && s.estimatedCostMinor > 0 && (
            <span className="inline-flex min-h-6 items-center rounded-[8px] border border-border bg-app px-2 text-[10.5px] font-semibold text-muted tabular-nums">
              {formatMinorAmount(s.estimatedCostMinor, currency)}
            </span>
          )}
        </div>

        {s.description && (
          <details
            className="group"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => event.stopPropagation()}
          >
            <summary className="absolute right-3 top-3 flex min-h-8 w-fit cursor-pointer list-none items-center gap-1.5 rounded-[9px] border border-warn/35 bg-warn-bg px-2.5 text-[10.5px] font-bold text-warn hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warn [&::-webkit-details-marker]:hidden">
              <FileText size={12} strokeWidth={2} aria-hidden="true" />
              <span className="group-open:hidden">備註</span>
              <span className="hidden group-open:inline">收起</span>
            </summary>
            <div className="-mx-3.5 mt-3 border-t border-border px-3.5 pt-3">
              <div className="flex items-center gap-1.5 text-[10.5px] font-bold text-warn">
                <SquarePen size={12} strokeWidth={2.2} aria-hidden="true" />
                備註事項
              </div>
              <div className="mt-2 rounded-[14px] border border-warn/45 bg-surface px-3 py-2.5">
                <p className="m-0 text-[11.5px] leading-[1.6] text-ink whitespace-pre-wrap break-words">
                  {s.description}
                </p>
              </div>
            </div>
          </details>
        )}
      </div>
    </div>
  )
}
