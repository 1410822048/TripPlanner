import { CircleHelp, Footprints, TrainFront } from 'lucide-react'
import type { Schedule } from '@/types'
import { resolvedPlace, scheduleLocationName } from '@/types/schedule'
import { googleMapsDirectionsUrl } from '../routePlanner'
import {
  NOTICE_TONE_TEXT,
  segmentLabel,
  segmentTravelMode,
  type FeasibilityNotice,
  type NoticeTone,
  type ScheduleSegment,
} from '../travelEstimate'
import GoogleMapsIcon from '@/components/icons/GoogleMapsIcon'

interface Props {
  from:    Schedule
  to:      Schedule
  segment: ScheduleSegment
  /** Arrival verdict for `to`, shown under the estimate. */
  notice?: FeasibilityNotice
}

const TONE_BORDER: Record<NoticeTone, string> = {
  danger: 'border-danger/40',
  warn:   'border-warn/50',
  muted:  'border-border',
}

export default function TravelSegmentRow({ from, to, segment, notice }: Props) {
  const fromName = scheduleLocationName(from.location)?.trim() || undefined
  const toName = scheduleLocationName(to.location)?.trim() || undefined
  const origin = resolvedPlace(from.location) ?? fromName
  const destination = resolvedPlace(to.location) ?? toName
  const { estimate } = segment
  const mapHref = origin && destination
    ? googleMapsDirectionsUrl(origin, destination, segmentTravelMode(estimate))
    : null
  const EstimateIcon = estimate.kind === 'walking'
    ? Footprints
    : estimate.kind === 'unknown' ? CircleHelp : TrainFront
  const measuredOnRoute = segment.basis === 'route'
    && estimate.kind !== 'unknown' && estimate.kind !== 'long-distance'

  return (
    <div className="relative pl-4 pb-2">
      <div
        className="absolute left-[15px] inset-y-0 w-[1.5px]"
        style={{
          background: `repeating-linear-gradient(to bottom, var(--color-dot) 0, var(--color-dot) 3px, transparent 3px, transparent 7px)`,
        }}
      />
      <div className="absolute left-[7px] top-1/2 z-10 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full border border-border bg-app text-teal">
        <EstimateIcon size={10} strokeWidth={2.2} aria-hidden="true" />
      </div>
      <div className={`ml-3 flex min-h-11 items-center justify-between gap-2 rounded-[14px] border bg-surface px-3 py-1.5 ${TONE_BORDER[notice?.tone ?? 'muted']}`}>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[10.5px] font-bold text-ink">{segmentLabel(estimate)}</span>
          {(measuredOnRoute || notice) && (
            <span className="truncate text-[10px] font-semibold leading-4 text-muted">
              {measuredOnRoute && '依實際路線'}
              {measuredOnRoute && notice && ' · '}
              {notice && <span className={NOTICE_TONE_TEXT[notice.tone]}>{notice.text}</span>}
            </span>
          )}
        </div>
        {mapHref && (
          <a
            href={mapHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`在 Google Maps 查看從 ${fromName ?? from.title} 到 ${toName ?? to.title} 的路線`}
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-[9px] bg-teal-pale px-2.5 text-[10px] font-bold text-teal no-underline hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <GoogleMapsIcon size={14} />
            路線
          </a>
        )}
      </div>
    </div>
  )
}
