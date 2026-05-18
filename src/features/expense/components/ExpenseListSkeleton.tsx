// src/features/expense/components/ExpenseListSkeleton.tsx
// Placeholder rows mirroring SwipeableExpenseItem(thumb + title +
// meta + amount)so the list layout stays put when real data arrives.
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Row() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-border rounded-xl">
      <div className="w-9 h-9 rounded-input bg-tile shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <SkeletonBar className="h-[13px] w-[55%]" />
        <SkeletonBar className="h-[10px] w-[35%]" />
      </div>
      <SkeletonBar className="h-[14px] w-[64px]" />
    </div>
  )
}

export default function ExpenseListSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded}>
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map(i => <Row key={i} />)}
      </div>
    </SkeletonContainer>
  )
}
