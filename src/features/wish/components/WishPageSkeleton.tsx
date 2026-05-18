// src/features/wish/components/WishPageSkeleton.tsx
import WishListSkeleton from './WishListSkeleton'
import { SkeletonBar, PageHeaderSkeleton, PageSkeletonShell } from '@/components/ui/skeleton'

export default function WishPageSkeleton() {
  return (
    <PageSkeletonShell>
      <PageHeaderSkeleton />

      {/* Tab switcher placeholder — same h-9 pill structure as real */}
      <div className="mx-4 mt-3 flex gap-1 p-1 rounded-card bg-app border border-border">
        {[0, 1].map(i => (
          <div key={i} className="flex-1 h-9 rounded-[8px] flex items-center justify-center gap-1.5">
            <SkeletonBar className="h-3 w-12" />
          </div>
        ))}
      </div>

      <div className="mt-4 px-4">
        <WishListSkeleton embedded />
      </div>
    </PageSkeletonShell>
  )
}
