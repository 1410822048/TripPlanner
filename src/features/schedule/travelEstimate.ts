// Schedule-facing glue around @tripmate/route-estimate-core: turns schedules
// into measurements, measurements into the shared segment class, and the
// day into arrival verdicts. The timeline and the route preview both go
// through here, so a segment reads the same before and after a route is
// applied — only the measurement source changes.
import {
  classifySegment,
  dayFeasibility,
  segmentTimeRange,
  straightLineMeters,
  type ArrivalFeasibility,
  type FeasibilityItem,
  type SegmentEstimate,
} from '@tripmate/route-estimate-core'
import type { Schedule, TimeMode } from '@/types'
import { resolvedPlace } from '@/types/schedule'
import type { GoogleMapsTravelMode } from './routePlanner'
import { toMinutes } from './routeModel'

// Local (no provider call) approximation used until a route is applied:
// straight line × a detour factor, at a walking pace.
const WALKING_ROUTE_FACTOR = 1.25
const WALKING_METERS_PER_MINUTE = 80
/** An "ok" arrival with at least this much worst-case slack is not worth a
 * line on the timeline. */
const QUIET_SLACK_MINUTES = 60

export interface WalkingMeasurement {
  walkingMinutes: number
  walkingDistanceMeters: number
}

export interface ScheduleSegment {
  estimate: SegmentEstimate
  /** Where the walking measurement came from; null when there is none. */
  basis: 'route' | 'local' | null
}

const UNKNOWN_SEGMENT: ScheduleSegment = { estimate: { kind: 'unknown' }, basis: null }

function localWalkingMeasurement(straightMeters: number): WalkingMeasurement {
  const walkingDistanceMeters = straightMeters * WALKING_ROUTE_FACTOR
  // No floor: two schedules at the same place are 0 minutes apart, exactly
  // as ORS measures them once a route is applied.
  return {
    walkingDistanceMeters,
    walkingMinutes: Math.ceil(walkingDistanceMeters / WALKING_METERS_PER_MINUTE),
  }
}

/** The applied route's measurement, only while both ends still belong to
 * the same applied revision and point at each other. */
function appliedMeasurement(from: Schedule, to: Schedule): WalkingMeasurement | undefined {
  const revision = from.routeRevision
  if (!revision || to.routeRevision !== revision) return undefined
  const leg = from.travelToNext
  return leg?.toId === to.id ? leg : undefined
}

/** Classify a segment from a given measurement (the route preview passes
 * the Worker's), or from a local estimate when there is none. */
export function classifyScheduleSegment(
  from: Schedule | undefined,
  to: Schedule | undefined,
  measured: WalkingMeasurement | undefined,
): ScheduleSegment {
  const origin = resolvedPlace(from?.location)
  const destination = resolvedPlace(to?.location)
  const straight = origin && destination ? straightLineMeters(origin, destination) : undefined
  const walking = measured ?? (straight === undefined ? undefined : localWalkingMeasurement(straight))
  if (!walking) return UNKNOWN_SEGMENT
  return {
    estimate: classifySegment({
      walkingMinutes: walking.walkingMinutes,
      walkingDistanceMeters: walking.walkingDistanceMeters,
      // A measured leg whose schedule the app has not synced yet still has
      // real numbers; approximate its straight line from the walking route.
      straightLineMeters: straight ?? walking.walkingDistanceMeters / WALKING_ROUTE_FACTOR,
      originIsTransport: from?.category === 'transport',
    }),
    basis: measured ? 'route' : 'local',
  }
}

/** The timeline's segment between two consecutive schedules. */
export function scheduleSegment(from: Schedule, to: Schedule): ScheduleSegment {
  return classifyScheduleSegment(from, to, appliedMeasurement(from, to))
}

export function segmentLabel(estimate: SegmentEstimate): string {
  switch (estimate.kind) {
    case 'walking':
      return estimate.walkingMinutes === 0 ? '同一地點，不需移動' : `步行約 ${estimate.walkingMinutes} 分鐘`
    case 'either':
      return `大眾運輸約 ${estimate.transit.minMinutes}–${estimate.transit.maxMinutes} 分 · 步行約 ${estimate.walkingMinutes} 分`
    case 'transit':
      return `大眾運輸約 ${estimate.transit.minMinutes}–${estimate.transit.maxMinutes} 分鐘`
    case 'long-distance':
      return '長途移動，請以訂單或時刻表為準'
    case 'unknown':
      return '交通時間待確認'
  }
}

export function segmentTravelMode(estimate: SegmentEstimate): GoogleMapsTravelMode {
  return estimate.kind === 'walking' ? 'walking' : 'transit'
}

/** Arrival verdict for every schedule of one day (undefined = no verdict).
 * A day spanning several time zones is skipped: its clock times do not
 * share one axis. */
export function scheduleDayFeasibility(
  items: Schedule[],
  segments: ScheduleSegment[],
): Array<ArrivalFeasibility | undefined> {
  const timeZones = new Set(items.flatMap(item => resolvedPlace(item.location)?.timeZone ?? []))
  if (timeZones.size > 1) return items.map(() => undefined)
  const feasibilityItems = items.map((item): FeasibilityItem => item.startTime
    ? { startMinutes: toMinutes(item.startTime), durationMinutes: item.durationMinutes }
    : { durationMinutes: item.durationMinutes })
  return dayFeasibility(feasibilityItems, segments.map(segment => segmentTimeRange(segment.estimate)))
}

export type NoticeTone = 'danger' | 'warn' | 'muted'

/** Text colour per tone, shared by the travel rows and the day summary. */
export const NOTICE_TONE_TEXT: Record<NoticeTone, string> = {
  danger: 'text-danger',
  warn:   'text-warn',
  muted:  'text-muted',
}

export interface FeasibilityNotice {
  status: ArrivalFeasibility['status']
  tone: NoticeTone
  text: string
}

function slackText(minSlack: number, maxSlack: number): string {
  return minSlack === maxSlack ? `${minSlack}` : `${minSlack}–${maxSlack}`
}

/** What to show on the travel row leading INTO a schedule. A missed
 * reservation (fixed) is more serious than a missed preferred time. */
export function feasibilityNotice(
  verdict: ArrivalFeasibility | undefined,
  timeMode: TimeMode,
): FeasibilityNotice | undefined {
  if (!verdict) return undefined
  switch (verdict.status) {
    case 'out-of-order':
      return { status: verdict.status, tone: 'warn', text: '開始時間早於上一個行程，順序可能要調整' }
    case 'overlap':
      return {
        status: verdict.status,
        tone: 'danger',
        text: verdict.flexibleBetween > 0
          ? `中間行程排不下，超出 ${verdict.overflowMinutes} 分鐘`
          : `與上一個行程時間重疊 ${verdict.overflowMinutes} 分鐘`,
      }
    case 'late':
      return {
        status: verdict.status,
        tone: timeMode === 'fixed' ? 'danger' : 'warn',
        text: `依估計至少晚到 ${verdict.lateMinutes} 分鐘`,
      }
    case 'possibly-late':
      return { status: verdict.status, tone: 'warn', text: `可能晚到，最多約 ${verdict.maxLateMinutes} 分鐘` }
    case 'tight':
      return { status: verdict.status, tone: 'warn', text: `時間很趕，餘裕約 ${slackText(verdict.minSlack, verdict.maxSlack)} 分鐘` }
    case 'ok':
      return verdict.minSlack < QUIET_SLACK_MINUTES
        ? { status: verdict.status, tone: 'muted', text: `餘裕約 ${slackText(verdict.minSlack, verdict.maxSlack)} 分鐘` }
        : undefined
    case 'unknown':
      return undefined
  }
}

const SUMMARY_LABELS: Array<[FeasibilityNotice['status'], string]> = [
  ['out-of-order', '時間順序不一致'],
  ['overlap', '時間重疊'],
  ['late', '預估遲到'],
  ['possibly-late', '可能遲到'],
  ['tight', '時間很趕'],
]

/** One line for the day header, only when something needs attention. */
export function feasibilitySummary(
  notices: Array<FeasibilityNotice | undefined>,
): { tone: NoticeTone; text: string } | undefined {
  const parts = SUMMARY_LABELS.flatMap(([status, label]) => {
    const count = notices.filter(notice => notice?.status === status).length
    return count > 0 ? [`${count} 處${label}`] : []
  })
  if (parts.length === 0) return undefined
  return {
    tone: notices.some(notice => notice?.tone === 'danger') ? 'danger' : 'warn',
    text: parts.join(' · '),
  }
}
