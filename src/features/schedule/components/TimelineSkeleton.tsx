// src/features/schedule/components/TimelineSkeleton.tsx
// Placeholder cards mirroring TimelineCard(emoji tile + title + cost
// chip + time/duration row).
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Card() {
  return (
    <div className="flex gap-3">
      <div className="w-12 h-12 rounded-xl bg-tile shrink-0" />
      <div className="flex-1 bg-surface border border-border rounded-xl px-3 py-2.5 space-y-2">
        <div className="flex justify-between items-start gap-2">
          <SkeletonBar className="h-[14px] w-[55%]" />
          <SkeletonBar className="h-[18px] w-[56px] rounded-card" />
        </div>
        <div className="flex gap-2.5">
          <SkeletonBar className="h-[10px] w-[44px]" />
          <SkeletonBar className="h-[10px] w-[60px]" />
        </div>
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
