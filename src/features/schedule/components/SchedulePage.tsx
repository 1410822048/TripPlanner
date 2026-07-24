// src/features/schedule/components/SchedulePage.tsx
// Layout orchestration only — state lives in useSchedulePageState,
// modals in TripModalsHost.
//
// TripModalsHost is lazy + gated on `hasOpenModal`: the whole modal layer
// (7 modals + the date/time pickers they pull in) is its own chunk that
// only downloads when the user first opens a modal, keeping it out of the
// /schedule landing bundle. The `modals` node is rendered identically in
// every return branch, so while a modal is open it's the same element in
// all of them — CreateTripModal still survives the EmptyTrips → main
// transition without remounting (hasOpenModal stays true across the swap).
import { lazy, Suspense, useState } from 'react'
import { Route } from 'lucide-react'
import TripSwitcher from '@/features/trips/components/TripSwitcher'
import TripHeaderCard from '@/features/trips/components/TripHeaderCard'
import SchedulePageSkeleton from './SchedulePageSkeleton'
import DaySelector from './DaySelector'
import DayTimeline from './DayTimeline'
import EmptyTrips from './EmptyTrips'
import TripsErrorState from './TripsErrorState'
import { useSchedulePageState } from '../hooks/useSchedulePageState'
import { routeOptimizationAvailability } from '../routeModel'

const TripModalsHost = lazy(() => import('./TripModalsHost'))
const RoutePreviewModal = lazy(() => import('./RoutePreviewModal'))

export default function SchedulePage() {
  const state = useSchedulePageState()
  const [routePreviewOpen, setRoutePreviewOpen] = useState(false)
  const {
    isDemo, canWrite, isOwner,
    cloudTripsLoading, cloudTripsError, cloudTripsEmpty, refetchTrips,
    trips, selectedTrip, dateRange, display, items, dayTotal,
    schedules, tripTotal, grouped, isLoading,
    selectTrip, deleteTrip, reorderTrips, handleMenuAction,
    scheduleModal, setActiveDate,
    setCreateTripOpen, setEditTripOpen, setInviteOpen, setInviteScannerOpen, setSignInOpen,
  } = state

  // fallback={null}: the host renders nothing until a modal opens, so the
  // brief chunk-load window on first open is invisible (no preload yet —
  // first open eats a small fetch; revisit if that lag is noticeable).
  const modals = state.hasOpenModal ? (
    <Suspense fallback={null}>
      <TripModalsHost state={state} />
    </Suspense>
  ) : null

  function openInviteScanner() {
    if (isDemo) setSignInOpen(true)
    else setInviteScannerOpen(true)
  }

  if (cloudTripsError) {
    return <>
      <TripsErrorState message={cloudTripsError.message} onRetry={refetchTrips} />
      {modals}
    </>
  }
  if (cloudTripsLoading) {
    return <>
      <SchedulePageSkeleton />
      {modals}
    </>
  }
  if (cloudTripsEmpty) {
    return <>
      <EmptyTrips
        onCreate={() => setCreateTripOpen(true)}
        onScanInvite={openInviteScanner}
      />
      {modals}
    </>
  }
  // Between auth resolution and AppLayout's useCurrentTripSync picking
  // a currentTrip, selectedTrip can briefly be null in cloud mode.
  if (!selectedTrip) {
    return <>
      <SchedulePageSkeleton />
      {modals}
    </>
  }

  const routeAvailability = routeOptimizationAvailability({
    canWrite,
    hasDate: Boolean(display),
    isDemo,
    locations: items.map(item => item.location),
  })
  let routeBlockedCopy: string | undefined
  if (routeAvailability.status === 'blocked') {
    switch (routeAvailability.reason) {
      case 'unresolved-locations':
        routeBlockedCopy = `還有 ${routeAvailability.count} 個地點需要從搜尋結果確認`
        break
      case 'too-many-schedules':
        routeBlockedCopy = `單日最多支援 12 個行程，目前有 ${routeAvailability.count} 個`
        break
      case 'mixed-time-zones':
        routeBlockedCopy = '同一天的地點時區不同，請先拆分行程'
        break
    }
  }

  return (
    <>
      <div className="bg-app min-h-full pb-8">
        {isDemo && (
          <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-accent-pale border border-accent/15 flex items-center gap-2">
            <div className="flex-1 min-w-0 text-[10.5px] text-accent leading-[1.5] tracking-[0.02em]">
              <span className="font-bold">預覽模式</span>
              <span className="opacity-75"> · 登入後可儲存自己的旅程</span>
            </div>
            <button
              onClick={() => setSignInOpen(true)}
              className="shrink-0 h-7 px-3 rounded-full bg-accent text-white text-[10.5px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.97]"
              style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
            >
              登入
            </button>
          </div>
        )}

        <div className="px-4 pt-3.5 pb-3 bg-app">
          <TripSwitcher
            trips={trips}
            selected={selectedTrip}
            onSelect={selectTrip}
            onAction={handleMenuAction}
            onDelete={deleteTrip}
            onReorder={reorderTrips}
            onCreateTrip={() => setCreateTripOpen(true)}
            onScanInvite={openInviteScanner}
            canDeleteLast={!isDemo}
            isOwner={isOwner}
          />
        </div>

        <TripHeaderCard
          selectedTrip={selectedTrip}
          tripDays={dateRange.length}
          scheduleCount={schedules.length}
          tripTotal={tripTotal}
          canInvite={isOwner}
          canEdit={isOwner}
          onEditTrip={() => setEditTripOpen(true)}
          onInvite={() => isDemo ? setSignInOpen(true) : setInviteOpen(true)}
        />

        <DaySelector
          dateRange={dateRange}
          display={display}
          grouped={grouped}
          onSelectDay={setActiveDate}
        />

        {routeAvailability.status !== 'hidden' && (
          <div className="mx-5 mt-3">
            <button
              type="button"
              aria-disabled={routeAvailability.status === 'blocked'}
              aria-describedby={routeBlockedCopy ? 'route-optimization-prerequisite' : undefined}
              onClick={() => {
                if (routeAvailability.status !== 'ready') return
                if (isDemo) setSignInOpen(true)
                else setRoutePreviewOpen(true)
              }}
              className={`inline-flex h-10 w-full items-center justify-center gap-2 rounded-chip border text-[12px] font-bold ${
                routeAvailability.status === 'blocked'
                  ? 'cursor-not-allowed border-border bg-surface text-muted'
                  : 'border-teal/30 bg-teal-pale text-teal'
              }`}
            >
              <Route size={15} aria-hidden="true" />
              {isDemo ? '登入後優化行程' : '優化行程'}
            </button>
            {routeBlockedCopy && (
              <p id="route-optimization-prerequisite" className="mt-1.5 px-1 text-[11px] leading-4 text-muted">
                {routeBlockedCopy}
              </p>
            )}
          </div>
        )}

        <DayTimeline
          display={display}
          items={items}
          dayTotal={dayTotal}
          isLoading={isLoading && !isDemo}
          canWrite={canWrite}
          currency={selectedTrip.currency}
          onAdd={scheduleModal.openAdd}
          onOpenDetails={state.openScheduleDetail}
        />
      </div>
      {modals}
      {!isDemo && selectedTrip && display && (
        <Suspense fallback={null}>
          <RoutePreviewModal
            key={`${selectedTrip.id}:${display}:${routePreviewOpen ? 'open' : 'closed'}`}
            isOpen={routePreviewOpen}
            tripId={selectedTrip.id}
            date={display}
            schedules={items}
            onClose={() => setRoutePreviewOpen(false)}
          />
        </Suspense>
      )}
    </>
  )
}
