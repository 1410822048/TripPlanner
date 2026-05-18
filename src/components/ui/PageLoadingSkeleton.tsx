// src/components/ui/PageLoadingSkeleton.tsx
// Full-page skeleton for top-level transitions(AppLayout Suspense,
// TripContext resolving, SchedulePage trips loading).
//
// Skeleton over spinner because PWA cold-start queries can take 200-800ms
// while persistence hydrates, and "structure already there, content
// coming" beats "is it stuck?" for perceived responsiveness.
import { SkeletonBar, SkeletonContainer, PageHeaderSkeleton } from './skeleton'

function ListRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-border rounded-xl">
      <div className="w-9 h-9 rounded-input bg-tile shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <SkeletonBar className="h-[13px] w-[55%]" />
        <SkeletonBar className="h-[10px] w-[35%]" />
      </div>
      <SkeletonBar className="h-[14px] w-[60px]" />
    </div>
  )
}

export default function PageLoadingSkeleton() {
  return (
    <SkeletonContainer className="bg-app min-h-full">
      <PageHeaderSkeleton />

      <div className="px-4 mt-2">
        <div className="bg-surface border border-border rounded-2xl p-5 space-y-2">
          <SkeletonBar className="h-[10px] w-[60px]" />
          <SkeletonBar className="h-[28px] w-[40%]" />
        </div>
      </div>

      <div className="mt-4 px-4 space-y-1.5">
        {[0, 1, 2].map(i => <ListRow key={i} />)}
      </div>
    </SkeletonContainer>
  )
}
