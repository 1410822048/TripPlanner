// src/features/planning/components/PlanningPageSkeleton.tsx
import PlanningListSkeleton from './PlanningListSkeleton'
import { SkeletonBar, PageHeaderSkeleton, PageSkeletonShell } from '@/components/ui/skeleton'

function HeaderStats() {
  return (
    <div className="shrink-0 text-right space-y-1">
      <SkeletonBar className="h-[20px] w-[56px] ml-auto" />
      <SkeletonBar className="h-[10px] w-[32px] ml-auto" />
    </div>
  )
}

export default function PlanningPageSkeleton() {
  return (
    <PageSkeletonShell>
      <PageHeaderSkeleton right={<HeaderStats />} />
      <div className="mt-4 px-4">
        <PlanningListSkeleton embedded />
      </div>
    </PageSkeletonShell>
  )
}
