// src/features/bookings/components/BookingsListSkeleton.tsx
// Placeholder rows shown while the bookings query resolves. Mirrors the
// shape of SwipeableBookingItem so the page layout doesn't shift when
// real data arrives — perceived as "loading a page" rather than "spinner
// → completely different UI". Same `animate-pulse` shimmer pattern as
// AccountPageSkeleton.
//
// 3 rows is enough to fill the visible area of a phone above the fold
// without making the placeholder look more "real" than the actual data
// would when only 1-2 bookings exist.

function Bar({ className = '' }: { className?: string }) {
  return <div className={`bg-tile rounded-md ${className}`} />
}

function Row() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-border rounded-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
      {/* Leading thumbnail slot — same 48×48 as the real row */}
      <div className="w-12 h-12 rounded-xl shrink-0 bg-tile" />
      {/* Title + subtitle */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <Bar className="h-[13px] w-[60%]" />
        <Bar className="h-[11px] w-[40%]" />
      </div>
    </div>
  )
}

export default function BookingsListSkeleton() {
  return (
    <div className="px-4 pt-2 animate-pulse">
      {/* Section header placeholder — matches the real "✈️ フライト  N 件" row */}
      <div className="flex items-center justify-between px-1 mb-2">
        <Bar className="h-[12px] w-[80px]" />
        <Bar className="h-[11px] w-[28px]" />
      </div>
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map(i => <Row key={i} />)}
      </div>
    </div>
  )
}
