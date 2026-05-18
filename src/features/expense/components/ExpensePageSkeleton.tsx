// src/features/expense/components/ExpensePageSkeleton.tsx
// Mirrors ExpensePage layout pixel-for-pixel so ctx.status === 'loading'
// transitions are a content swap on stable chrome, not a wholesale page
// swap.
import ExpenseListSkeleton from './ExpenseListSkeleton'
import { SkeletonBar, PageHeaderSkeleton, PageSkeletonShell } from '@/components/ui/skeleton'

export default function ExpensePageSkeleton() {
  return (
    <PageSkeletonShell>
      <PageHeaderSkeleton />

      <div className="px-4 mt-2">
        <div className="bg-surface border border-border rounded-2xl p-5 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
          <SkeletonBar className="h-[10.5px] w-[70px]" />
          <div className="mt-1 flex items-baseline gap-1">
            <SkeletonBar className="h-[18px] w-[20px]" />
            <SkeletonBar className="h-[28px] w-[120px]" />
          </div>

          <div className="mt-4 pt-4 border-t border-border grid grid-cols-3 gap-2">
            {[0, 1, 2].map(i => (
              <div key={i} className="flex flex-col items-center gap-1">
                <SkeletonBar className="h-[18px] w-[44px]" />
                <SkeletonBar className="h-[10.5px] w-[48px]" />
              </div>
            ))}
          </div>

          <div className="mt-4 h-11 w-full rounded-chip bg-tile" />
        </div>
      </div>

      <div className="mt-4 px-4">
        <ExpenseListSkeleton embedded />
      </div>
    </PageSkeletonShell>
  )
}
