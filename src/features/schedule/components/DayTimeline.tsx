// src/features/schedule/components/DayTimeline.tsx
// Renders the schedule cards for a single day plus the "add" affordance.
// Three states: loading skeleton / empty card with CTA / timeline + add row.
import { Fragment } from 'react'
import { Plus, Route } from 'lucide-react'
import TimelineSkeleton from './TimelineSkeleton'
import TimelineCard from './TimelineCard'
import TravelSegmentRow from './TravelSegmentRow'
import type { Schedule } from '@/types'
// `new Date('YYYY-MM-DD')` is UTC midnight, so west of Greenwich both the
// date and the weekday rendered a day early. fromLocalDateString anchors
// the same string at LOCAL midnight, which is what a day header means.
import { fromLocalDateString } from '@/utils/dates'
import { formatMinorAmount } from '@/utils/money'
import type { TravelSegmentEstimate } from '../routePlanner'
import ListEmptyCard from '@/components/ui/ListEmptyCard'
import GhostAddButton from '@/components/ui/GhostAddButton'
import { UPDATE_REQUIRED_EMPTY_STATE } from '@/services/clientCompatibility'

interface Props {
  display:    string | undefined        // active 'YYYY-MM-DD'
  items:      Schedule[]
  dayTotal:   number                    // sum of estimatedCostMinor for items (integer minor units)
  isLoading:  boolean
  /** Owner / editor — controls visibility of add affordances. Viewers
   *  see the timeline but no add buttons (mirrors firestore.rules
   *  canWrite gating on the schedules subcollection). */
  canWrite:   boolean
  /** Role-only half of `canWrite`. Checked FIRST when blocked: a viewer
   *  stays a viewer after updating the app, so promising "update and you
   *  can add" would be a lie for them. */
  roleCanWrite: boolean
  /** ISO currency code of the active trip — passed in (rather than
   *  hooked via useTripCurrency) so the memo comparator below includes
   *  it. Without that the daily total + per-card costs would stay in
   *  the old symbol after the user changes currency. */
  currency:   string
  routeAction: {
    status:      'ready' | 'blocked'
    description: string | undefined
    onClick:     () => void
  } | undefined
  onAdd:      () => void
  onOpenDetails: (s: Schedule) => void
}

function DayTimeline({
  display, items, dayTotal, isLoading, canWrite, roleCanWrite, currency, routeAction, onAdd, onOpenDetails,
}: Props) {
  return (
    <div className="mx-5 mt-5">
      {display && (
        <div className="mb-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div>
                <span className="text-[15px] font-bold text-ink">
                  {fromLocalDateString(display).toLocaleDateString('zh-TW', { month:'long', day:'numeric' })}
                </span>
                <span className="text-[12px] text-muted ml-1.5">
                  {fromLocalDateString(display).toLocaleDateString('zh-TW', { weekday:'long' })}
                </span>
              </div>
              {!isLoading && items.length > 0 && (
                <p className="mt-1 text-[11px] font-medium text-muted tabular-nums">
                  {items.length} 個行程
                  {items.length > 1 && ` · ${items.length - 1} 段交通`}
                  {dayTotal > 0 && ` · 合計 ${formatMinorAmount(dayTotal, currency)}`}
                </p>
              )}
            </div>
            {routeAction && (
              <button
                type="button"
                aria-disabled={routeAction.status === 'blocked'}
                aria-describedby={routeAction.description ? 'route-optimization-prerequisite' : undefined}
                onClick={routeAction.onClick}
                className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-chip border px-3 text-[11px] font-bold ${
                  routeAction.status === 'blocked'
                    ? 'cursor-not-allowed border-border bg-surface text-muted'
                    : 'border-teal/30 bg-teal-pale text-teal'
                }`}
              >
                <Route size={14} aria-hidden="true" />
                優化行程
              </button>
            )}
          </div>
          {routeAction?.description && (
            <p id="route-optimization-prerequisite" className="mt-1.5 px-1 text-[11px] leading-4 text-muted">
              {routeAction.description}
            </p>
          )}
        </div>
      )}

      {isLoading ? (
        <TimelineSkeleton />
      ) : items.length === 0 ? (
        <ListEmptyCard
          icon={<div className="text-[40px] mb-1.5 opacity-55">🗓</div>}
          title="這天還沒有行程"
          description={canWrite
            ? '先新增第一個行程吧'
            : roleCanWrite
              ? UPDATE_REQUIRED_EMPTY_STATE
              : '你目前以檢視者身分加入。只有擁有者和編輯者可以新增行程。'}
          actions={canWrite ? (
            <button
              type="button"
              onClick={onAdd}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              新增行程
            </button>
          ) : undefined}
        />
      ) : (
        <>
          {items.map((s, idx) => {
            const next = items[idx + 1]
            const appliedEstimate = next ? appliedRouteEstimate(s, next) : undefined
            return (
              <Fragment key={s.id}>
                <TimelineCard
                  s={s}
                  isLast={!next}
                  currency={currency}
                  onOpenDetails={() => onOpenDetails(s)}
                />
                {next && <TravelSegmentRow from={s} to={next} appliedEstimate={appliedEstimate} />}
              </Fragment>
            )
          })}

          {canWrite && (
            <div className="mt-2.5 pl-[26px]">
              <GhostAddButton label="新增行程" onClick={onAdd} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function appliedRouteEstimate(
  from: Schedule,
  to: Schedule,
): TravelSegmentEstimate | undefined {
  const revision = from.routeRevision
  if (!revision || to.routeRevision !== revision) return undefined
  const leg = from.travelToNext
  if (!leg || leg.toId !== to.id) return undefined
  return leg.kind === 'walking'
    ? { kind: 'walking', minutes: leg.minutes }
    : { kind: 'transit', minMinutes: leg.minMinutes, maxMinutes: leg.maxMinutes }
}

export default DayTimeline
