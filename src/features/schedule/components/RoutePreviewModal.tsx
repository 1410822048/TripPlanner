import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Check,
  ChevronUp,
  Footprints,
  Info,
  Loader2,
  RefreshCw,
  Route,
  TrainFront,
  TriangleAlert,
} from 'lucide-react'
import type { Schedule } from '@/types'
import { resolvedPlace } from '@/types/schedule'
import { WorkerRejected } from '@/services/workerBase'
import {
  applyRoutePreview,
  requestRoutePreview,
  routeErrorMessage,
  type RoutePreview,
} from '../services/routeOptimizationService'
import { googleMapsDirectionsUrl } from '../routePlanner'
import BottomSheet from '@/components/ui/BottomSheet'
import GoogleMapsIcon from '@/components/icons/GoogleMapsIcon'

const RoutePreviewMap = lazy(() => import('./RoutePreviewMap'))

interface Props {
  isOpen: boolean
  tripId: string
  date: string
  schedules: Schedule[]
  onClose: () => void
}

interface RoutePreviewError {
  message: string
  canRetryPreview: boolean
}

interface PreviewSectionProps {
  preview: RoutePreview
  scheduleById: Map<string, Schedule>
  timeConflicts: Set<string>
}

const FRESH_PREVIEW_REQUIRED_CODES = new Set([
  'PREVIEW_STALE',
  'PREVIEW_TOKEN_INVALID',
  'PREVIEW_PAYLOAD_MISMATCH',
  'REVISION_CONFLICT',
])

function StopTimeline({ preview, scheduleById, timeConflicts }: PreviewSectionProps) {
  const orderedStops = [...preview.applyPlan.schedules].sort((left, right) => left.order - right.order)
  const legByOrigin = new Map(preview.legs.map(leg => [leg.fromId, leg]))

  return (
    <section role="region" aria-label="站點與路線規劃" className="shrink-0">
      <h3 className="sr-only">站點與路線規劃</h3>
      <span className="sr-only">共 {orderedStops.length} 個地點</span>

      <ol className="m-0 list-none space-y-0 p-0">
        {orderedStops.map((plannedStop, index) => {
          const item = scheduleById.get(plannedStop.id)
          const title = item?.title ?? plannedStop.id
          const time = item?.startTime
          const hasTimeConflict = timeConflicts.has(plannedStop.id)
          const leg = legByOrigin.get(plannedStop.id)
          const nextItem = leg ? scheduleById.get(leg.toId) : undefined
          const origin = leg ? resolvedPlace(item?.location) : undefined
          const destination = leg ? resolvedPlace(nextItem?.location) : undefined
          const directionsHref = leg && origin && destination
            ? googleMapsDirectionsUrl(origin, destination, leg.kind === 'walking' ? 'walking' : 'transit')
            : null
          const routeModeLabel = leg?.kind === 'walking' ? '步行路線' : '大眾運輸'
          const isLast = index === orderedStops.length - 1

          return (
            <li
              key={plannedStop.id}
              className={`relative grid grid-cols-[30px_minmax(0,1fr)] gap-2.5 ${isLast ? '' : 'pb-1'}`}
            >
              {!isLast && (
                <span aria-hidden className="absolute bottom-[-4px] left-[13px] top-7 border-l-2 border-teal/25" />
              )}
              <span className="relative z-[1] mt-3 grid h-7 w-7 place-items-center rounded-full bg-teal text-[11px] font-extrabold text-white shadow-[0_1px_3px_rgba(61,139,122,0.22)]">
                {index + 1}
              </span>

              <div className="min-w-0">
                <div className={`flex min-h-[54px] items-center justify-between gap-2 rounded-chip border bg-surface px-3.5 py-2.5 shadow-[0_1px_4px_rgba(32,42,45,0.035)] ${hasTimeConflict ? 'border-warn/55' : 'border-border'}`}>
                  <span className="min-w-0 truncate text-[13.5px] font-extrabold text-ink">{title}</span>
                  <span
                    aria-label={time ? (hasTimeConflict ? `${time}，時間需確認` : undefined) : '時間未定'}
                    className={`inline-flex min-h-7 shrink-0 items-center gap-1 rounded-chip px-2.5 py-1 text-[10.5px] font-bold ${
                      hasTimeConflict
                        ? 'bg-warn-bg text-warn'
                        : time
                          ? 'bg-teal-pale text-teal'
                          : 'bg-app/80 text-muted'
                    } ${time ? 'font-mono' : ''}`}
                  >
                    {time ?? '時間未定'}
                  </span>
                </div>

                {leg && (
                  <div className="flex min-h-12 items-center justify-between gap-2 px-2 py-2 text-[11px] font-semibold text-muted">
                    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-tile px-2.5 py-1.5">
                      {leg.kind === 'walking' ? (
                        <Footprints size={13} aria-hidden className="shrink-0 text-teal" />
                      ) : (
                        <TrainFront size={13} aria-hidden className="shrink-0 text-teal" />
                      )}
                      <span className="truncate">
                        {leg.kind === 'walking'
                          ? `步行約 ${Math.round(leg.walkingMinutes)} 分鐘${leg.geometryAvailable ? '' : '・路線未顯示'}`
                          : `大眾運輸估計約 ${leg.transitEstimate.minMinutes}–${leg.transitEstimate.maxMinutes} 分鐘`}
                      </span>
                    </span>
                    {directionsHref && (
                      <a
                        href={directionsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`在 Google 地圖查看${title}到${nextItem?.title ?? leg.toId}的${routeModeLabel}`}
                        className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-chip border border-border bg-surface px-2.5 font-bold text-teal no-underline shadow-[0_1px_3px_rgba(32,42,45,0.04)] transition-colors hover:bg-teal-pale focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                      >
                        地圖
                        <GoogleMapsIcon size={15} />
                      </a>
                    )}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

interface ExplanationSummaryProps {
  preview: RoutePreview
  timeConflicts: Set<string>
  expanded: boolean
  onToggle: () => void
}

function ExplanationSummary({ preview, timeConflicts, expanded, onToggle }: ExplanationSummaryProps) {
  const routeNeedsNoChange = !preview.routeChanged
  const summaryTitle = routeNeedsNoChange
    ? '目前順序已相當順暢，無需套用'
    : preview.canApply
      ? '已整理為較順路的順序'
      : '預覽完成，但目前無法套用'

  return (
    <section className="shrink-0 overflow-hidden rounded-card border border-border bg-surface shadow-[0_2px_12px_rgba(32,42,45,0.06)]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? '收起路線說明' : '展開路線說明'}
        onClick={onToggle}
        className="flex min-h-11 w-full items-center gap-2 border-none bg-transparent px-3 py-2 text-left hover:bg-app/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal"
      >
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${preview.canApply || routeNeedsNoChange ? 'bg-teal' : 'bg-warn'}`} />
        <span className="min-w-0 flex-1 text-[11.5px] font-extrabold text-ink">{summaryTitle}</span>
        <span className="shrink-0 text-[10.5px] font-semibold text-muted">{expanded ? '收起' : '展開'}</span>
        <ChevronUp size={13} className={`shrink-0 text-muted transition-transform ${expanded ? '' : 'rotate-180'}`} />
      </button>

      {expanded && (
        <div className="border-t border-border/70 px-3 py-2.5">
          <div className="flex items-start gap-2 text-[10.5px] leading-5 text-muted">
            <Info size={13} className="mt-0.5 shrink-0 text-warn" />
            <div className="flex min-w-0 flex-col">
              <span>僅依地點位置整理順序，不含大眾運輸精確時間計算。</span>
              <span>固定行程仍需自行確認抵達時間。</span>
            </div>
          </div>

          {preview.confidence === 'transit-unverified' ? (
            <div className="mt-1.5 flex items-start gap-2 text-[10.5px] leading-5 text-muted">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" />
              <span>長距離時間以 40 km/h 參考速度及 5 分鐘候車估值推算，不代表實際班次與轉乘時間。</span>
            </div>
          ) : (
            <div className="mt-1.5 flex items-start gap-2 text-[10.5px] leading-5 text-muted">
              <Footprints size={13} className="mt-0.5 shrink-0 text-teal" />
              <span>所有路段步行時間皆在 15 分鐘內。</span>
            </div>
          )}

          {preview.geometryDegraded && (
            <div className="mt-1.5 flex items-start gap-2 text-[10.5px] leading-5 text-muted">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" />
              <span>部分步行路線無法顯示；排序仍已透過 ORS 距離矩陣確認。</span>
            </div>
          )}

          {timeConflicts.size > 0 && (
            <div className="mt-1.5 flex items-start gap-2 text-[10.5px] leading-5 text-muted">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warn" />
              <span>新順序與原本的偏好時間不一致；系統不會修改時間。</span>
            </div>
          )}

          <div className="mt-1.5 flex items-start gap-2 text-[10.5px] leading-5 text-muted">
            <Route size={13} className="mt-0.5 shrink-0 text-accent" />
            <span>地圖實線為 ORS 步行路線；灰色虛線僅供參考，不代表實際大眾運輸路徑。</span>
          </div>
        </div>
      )}
    </section>
  )
}

export default function RoutePreviewModal({ isOpen, tripId, date, schedules, onClose }: Props) {
  const [preview, setPreview] = useState<RoutePreview | null>(null)
  const [loading, setLoading] = useState(isOpen)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<RoutePreviewError | null>(null)
  const [applied, setApplied] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [explanationExpanded, setExplanationExpanded] = useState(true)

  useEffect(() => {
    if (!isOpen) return
    let active = true
    requestRoutePreview(tripId, date)
      .then(result => { if (active) setPreview(result) })
      .catch(reason => {
        if (!active) return
        setPreview(null)
        setError({
          message: routeErrorMessage(reason, 'preview'),
          canRetryPreview: true,
        })
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [isOpen, tripId, date, previewAttempt])

  function handleRetryPreview() {
    if (loading) return
    setPreview(null)
    setError(null)
    setLoading(true)
    setPreviewAttempt(attempt => attempt + 1)
  }

  async function handleApply() {
    if (!preview?.canApply || applying) return
    setApplying(true)
    setError(null)
    try {
      await applyRoutePreview(tripId, preview)
      setApplied(true)
    } catch (reason) {
      const requiresFreshPreview = reason instanceof WorkerRejected
        && reason.code !== undefined
        && FRESH_PREVIEW_REQUIRED_CODES.has(reason.code)
      if (requiresFreshPreview) setPreview(null)
      setError({
        message: routeErrorMessage(reason, 'apply'),
        canRetryPreview: requiresFreshPreview,
      })
    } finally {
      setApplying(false)
    }
  }

  const scheduleById = new Map(schedules.map(schedule => [schedule.id, schedule]))
  const stopPlan = preview?.applyPlan.schedules ?? schedules.map((schedule, order) => ({ id: schedule.id, order }))
  const stops = stopPlan
    .map(({ id, order }) => {
      const schedule = scheduleById.get(id)
      const place = resolvedPlace(schedule?.location)
      return place ? { id, label: schedule?.title ?? id, order, lng: place.lng, lat: place.lat } : null
    })
    .filter((stop): stop is { id: string; label: string; order: number; lng: number; lat: number } => Boolean(stop))
  const timeConflicts = new Set(preview?.timeConflictScheduleIds ?? [])

  return (
    <BottomSheet
      isOpen={isOpen}
      title="順路整理預覽"
      onClose={onClose}
      dismissible={!applying}
      footer={(
        <div className="flex gap-2">
          <button
            type="button"
            disabled={applying}
            onClick={onClose}
            className="h-11 flex-1 rounded-chip border border-border bg-surface text-[13px] font-semibold text-muted disabled:cursor-not-allowed disabled:opacity-45"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!preview?.canApply || loading || applying || applied}
            onClick={() => void handleApply()}
            className="h-11 flex-[1.5] rounded-chip border-none bg-teal text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {applying
              ? <Loader2 size={15} className="mx-auto animate-spin" />
              : applied
                ? <span className="inline-flex items-center gap-1"><Check size={15} /> 已套用</span>
                : preview && !preview.routeChanged
                  ? '無需套用'
                  : '套用此順序'}
          </button>
        </div>
      )}
    >
      {loading && (
        <div className="flex items-center gap-2 rounded-card border border-border bg-app px-3 py-3 text-[12px] text-muted">
          <Loader2 size={15} className="animate-spin" />正在檢查順路…
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-card border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] text-amber-800">
          <TriangleAlert size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 leading-5">{error.message}</span>
          {error.canRetryPreview && (
            <button
              type="button"
              onClick={handleRetryPreview}
              className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-chip border border-amber-300 bg-white px-3 font-bold text-amber-800"
            >
              <RefreshCw size={13} />
              重新檢查
            </button>
          )}
        </div>
      )}
      {preview && (
        <>
          <Suspense fallback={<div className="h-60 min-h-60 shrink-0 rounded-[16px] bg-app" />}>
            <RoutePreviewMap
              geometry={preview.display}
              stops={stops}
              previewRevision={preview.previewRevision}
            />
          </Suspense>
          <StopTimeline preview={preview} scheduleById={scheduleById} timeConflicts={timeConflicts} />
          <ExplanationSummary
            preview={preview}
            timeConflicts={timeConflicts}
            expanded={explanationExpanded}
            onToggle={() => setExplanationExpanded(value => !value)}
          />
        </>
      )}
    </BottomSheet>
  )
}
