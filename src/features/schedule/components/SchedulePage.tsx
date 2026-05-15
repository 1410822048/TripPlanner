// src/features/schedule/components/SchedulePage.tsx
// Layout orchestration only: pull state from useSchedulePageState, hand
// the modal slice to TripModalsHost, render the trip switcher + header
// card + day timeline. Anything stateful or behavioural lives in the
// hook; anything per-modal lives in TripModalsHost.
import TripSwitcher from '@/features/trips/components/TripSwitcher'
import TripHeaderCard from '@/features/trips/components/TripHeaderCard'
import LoadingText from '@/components/ui/LoadingText'
import CreateTripModal from '@/features/trips/components/CreateTripModal'
import DaySelector from './DaySelector'
import DayTimeline from './DayTimeline'
import EmptyTrips from './EmptyTrips'
import TripsErrorState from './TripsErrorState'
import TripModalsHost from './TripModalsHost'
import { useSchedulePageState } from '../hooks/useSchedulePageState'

export default function SchedulePage() {
  const state = useSchedulePageState()
  const {
    isDemo, canWrite, isOwner,
    cloudTripsLoading, cloudTripsError, cloudTripsEmpty, refetchTrips,
    trips, selectedTrip, dateRange, display, items, dayTotal,
    schedules, tripTotal, grouped, isLoading,
    selectTrip, deleteTrip, reorderTrips, handleMenuAction,
    openAdd, openEdit, setActiveDate,
    createTripOpen, setCreateTripOpen, setEditTripOpen, setInviteOpen, setSignInOpen,
  } = state

  // Cloud-mode early returns. Order matters: error → loading → empty.
  // Demo mode skips all three (selectedTrip is always defined).
  if (cloudTripsError) {
    return <TripsErrorState message={cloudTripsError.message} onRetry={refetchTrips} />
  }
  if (cloudTripsLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-[13px]">
        <LoadingText />
      </div>
    )
  }
  if (cloudTripsEmpty) {
    // Empty-state owns its own CreateTripModal so the user can resolve
    // it without leaving the page.
    return (
      <>
        <EmptyTrips onCreate={() => setCreateTripOpen(true)} />
        <CreateTripModal isOpen={createTripOpen} onClose={() => setCreateTripOpen(false)} />
      </>
    )
  }

  // Between auth resolution and AppLayout's useCurrentTripSync picking
  // a currentTrip, selectedTrip can briefly be null in cloud mode.
  if (!selectedTrip) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-[13px]">
        <LoadingText />
      </div>
    )
  }

  return (
    <div className="bg-app min-h-full pb-8">
      {isDemo && (
        <div className="mx-4 mt-3 mb-1 px-3 py-2 rounded-xl bg-accent-pale border border-accent/15 flex items-center gap-2">
          <div className="flex-1 min-w-0 text-[10.5px] text-accent leading-[1.5] tracking-[0.02em]">
            <span className="font-bold">プレビューモード</span>
            <span className="opacity-75"> · サインインで自分の旅程を保存</span>
          </div>
          <button
            onClick={() => setSignInOpen(true)}
            className="shrink-0 h-7 px-3 rounded-full bg-accent text-white text-[10.5px] font-bold tracking-[0.04em] border-none cursor-pointer transition-all hover:brightness-110 active:scale-[0.97]"
            style={{ boxShadow: '0 2px 6px rgba(61,139,122,0.25)' }}
          >
            サインイン
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
          canDeleteLast={!isDemo}
          // Demo mode has no real ownership — every trip belongs to
          // "you", so all menu actions are visible. In cloud mode, gate
          // owner-only entries (edit metadata / share invite link /
          // settings) behind a real ownerId match.
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

      <DayTimeline
        display={display}
        items={items}
        dayTotal={dayTotal}
        isLoading={isLoading && !isDemo}
        canWrite={canWrite}
        currency={selectedTrip.currency}
        onAdd={openAdd}
        onEdit={openEdit}
      />

      <TripModalsHost state={state} />
    </div>
  )
}
