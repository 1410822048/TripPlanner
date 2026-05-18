// src/features/bookings/components/BookingsListSkeleton.tsx
// Placeholder rows shown while the bookings query resolves. Mirrors
// SwipeableBookingItem so the layout doesn't shift on data arrival.
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Row() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-border rounded-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
      <div className="w-12 h-12 rounded-xl shrink-0 bg-tile" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <SkeletonBar className="h-[13px] w-[60%]" />
        <SkeletonBar className="h-[11px] w-[40%]" />
      </div>
    </div>
  )
}

export default function BookingsListSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded} className="px-4 pt-2">
      <div className="flex items-center justify-between px-1 mb-2">
        <SkeletonBar className="h-[12px] w-[80px]" />
        <SkeletonBar className="h-[11px] w-[28px]" />
      </div>
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map(i => <Row key={i} />)}
      </div>
    </SkeletonContainer>
  )
}
