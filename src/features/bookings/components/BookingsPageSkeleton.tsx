// src/features/bookings/components/BookingsPageSkeleton.tsx
import BookingsListSkeleton from './BookingsListSkeleton'
import { PageHeaderSkeleton, PageSkeletonShell } from '@/components/ui/skeleton'

export default function BookingsPageSkeleton() {
  return (
    <PageSkeletonShell>
      <PageHeaderSkeleton />
      <div className="mt-4">
        <BookingsListSkeleton embedded />
      </div>
    </PageSkeletonShell>
  )
}
