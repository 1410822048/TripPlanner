import { Footprints, TrainFront } from 'lucide-react'
import type { Schedule } from '@/types'
import { resolvedPlace, scheduleLocationName } from '@/types/schedule'
import {
  estimateTravelSegment,
  googleMapsDirectionsUrl,
  type TravelSegmentEstimate,
} from '../routePlanner'
import GoogleMapsIcon from '@/components/icons/GoogleMapsIcon'

interface Props {
  from: Schedule
  to:   Schedule
  appliedEstimate?: TravelSegmentEstimate
}

export default function TravelSegmentRow({ from, to, appliedEstimate }: Props) {
  const fromName = scheduleLocationName(from.location)?.trim() || undefined
  const toName = scheduleLocationName(to.location)?.trim() || undefined
  const fromPlace = resolvedPlace(from.location)
  const toPlace = resolvedPlace(to.location)
  const estimate = appliedEstimate ?? (fromPlace && toPlace
    ? estimateTravelSegment(fromPlace, toPlace)
    : null)
  const origin = fromPlace ?? fromName
  const destination = toPlace ?? toName
  const mapHref = origin && destination
    ? googleMapsDirectionsUrl(origin, destination, estimate?.kind === 'walking' ? 'walking' : 'transit')
    : null
  const estimateLabel = estimate?.kind === 'walking'
    ? `步行估計約 ${estimate.minutes} 分鐘`
    : estimate?.kind === 'transit'
      ? `大眾運輸估計約 ${estimate.minMinutes}–${estimate.maxMinutes} 分鐘`
      : '交通時間待確認'
  const EstimateIcon = estimate?.kind === 'walking' ? Footprints : TrainFront

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
      <div className="ml-3 flex min-h-11 items-center justify-between gap-2 rounded-[14px] border border-border bg-surface px-3 py-1.5">
        <span className="min-w-0 truncate text-[10.5px] font-bold text-ink">{estimateLabel}</span>
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
