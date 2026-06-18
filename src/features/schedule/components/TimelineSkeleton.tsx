// src/features/schedule/components/TimelineSkeleton.tsx
// Placeholder cards mirroring TimelineCard(emoji tile + title + cost
// chip + time/duration row).
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Card() {
  return (
    <div className="relative pl-4 pb-4 last:pb-0">
      <div
        className="absolute left-[13px] top-[30px] bottom-0 w-[1.5px]"
        style={{
          background: `repeating-linear-gradient(to bottom, var(--color-dot) 0, var(--color-dot) 3px, transparent 3px, transparent 7px)`,
        }}
      />
      <div className="absolute left-0 top-1 z-10 w-[28px] h-[28px] rounded-full border-[2px] border-app bg-tile shadow-[0_2px_8px_rgba(32,42,45,0.08)]" />
      <div className="ml-2.5 min-h-[92px] bg-surface border border-l-[4px] border-border rounded-[20px] pl-4 pr-4 py-3 space-y-3">
        <div className="flex gap-2.5">
          <SkeletonBar className="h-[10px] w-[78px]" />
          <SkeletonBar className="h-[10px] w-[86px]" />
        </div>
        <div className="flex justify-between items-start gap-2">
          <SkeletonBar className="h-[14px] w-[55%]" />
          <SkeletonBar className="h-[18px] w-[56px] rounded-card" />
        </div>
        <SkeletonBar className="h-[10px] w-[64%]" />
      </div>
    </div>
  )
}

export default function TimelineSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded}>
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map(i => <Card key={i} />)}
      </div>
    </SkeletonContainer>
  )
}
