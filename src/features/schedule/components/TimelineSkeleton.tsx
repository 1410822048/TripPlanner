// src/features/schedule/components/TimelineSkeleton.tsx
// Placeholder cards mirroring TimelineCard plus the travel connector rows.
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Card({ isLast }: { isLast: boolean }) {
  return (
    <div className="relative pl-4 pb-2">
      <div
        className={`absolute left-[15px] top-0 w-[1.5px] ${isLast ? 'h-[18px]' : 'bottom-0'}`}
        style={{ background: 'var(--color-dot)' }}
      />
      <div className="absolute left-0 top-0.5 z-10 h-8 w-8 rounded-[11px] border-[2px] border-app bg-tile shadow-[0_2px_8px_rgba(32,42,45,0.08)]" />
      <div className="ml-3 min-h-[104px] space-y-3 rounded-[20px] border border-border bg-surface px-3.5 py-3">
        <div className="flex gap-1 pb-2.5">
          <SkeletonBar className="h-6 w-[86px] rounded-[8px]" />
          <SkeletonBar className="h-6 w-[72px] rounded-[8px]" />
        </div>
        <SkeletonBar className="h-[14px] w-[55%]" />
        <SkeletonBar className="h-[10px] w-[64%]" />
        <div className="flex gap-1.5">
          <SkeletonBar className="h-6 w-[48px] rounded-[8px]" />
          <SkeletonBar className="h-6 w-[58px] rounded-[8px]" />
        </div>
      </div>
    </div>
  )
}

function Segment() {
  return (
    <div className="relative pl-4 pb-2">
      <div
        className="absolute left-[15px] inset-y-0 w-[1.5px]"
        style={{
          background: `repeating-linear-gradient(to bottom, var(--color-dot) 0, var(--color-dot) 3px, transparent 3px, transparent 7px)`,
        }}
      />
      <div className="ml-3 flex min-h-11 items-center justify-between gap-2 rounded-[14px] border border-border bg-surface px-3 py-1.5">
        <SkeletonBar className="h-[10px] w-[120px]" />
        <SkeletonBar className="h-8 w-[54px] rounded-[9px]" />
      </div>
    </div>
  )
}

export default function TimelineSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded}>
      <div>
        {[0, 1, 2].map(i => (
          <div key={i}>
            <Card isLast={i === 2} />
            {i < 2 && <Segment />}
          </div>
        ))}
      </div>
    </SkeletonContainer>
  )
}
