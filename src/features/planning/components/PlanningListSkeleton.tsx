// src/features/planning/components/PlanningListSkeleton.tsx
// Placeholder rows mirroring PlanningRow(checkbox + title)plus
// category section headers, matching the page's grouped structure.
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

function Row() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 bg-surface border border-border rounded-xl">
      <div className="w-5 h-5 rounded-md bg-tile shrink-0" />
      <div className="flex-1 min-w-0 space-y-1.5">
        <SkeletonBar className="h-[13px] w-[55%]" />
        <SkeletonBar className="h-[10px] w-[30%]" />
      </div>
    </div>
  )
}

function Section() {
  return (
    <div className="space-y-1.5">
      <SkeletonBar className="h-[11px] w-[80px] mb-1" />
      <Row />
      <Row />
    </div>
  )
}

export default function PlanningListSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded}>
      <div className="flex flex-col gap-4">
        <Section />
        <Section />
      </div>
    </SkeletonContainer>
  )
}
