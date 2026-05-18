// src/features/schedule/components/SchedulePageSkeleton.tsx
// Schedule's header is a rounded card with member chips, distinct from
// the label+title pattern other pages use — handled inline rather than
// via PageHeaderSkeleton.
import TimelineSkeleton from './TimelineSkeleton'
import { SkeletonBar, PageSkeletonShell } from '@/components/ui/skeleton'

export default function SchedulePageSkeleton() {
  return (
    <PageSkeletonShell>
      {/* Trip switcher pills */}
      <div className="px-4 pt-3.5 pb-3 flex gap-2 overflow-hidden">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-9 rounded-full bg-tile w-24 shrink-0" />
        ))}
      </div>

      {/* Trip header card */}
      <div className="px-4">
        <div className="bg-surface border border-border rounded-[22px] px-4 pt-4 pb-4 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <div className="flex justify-between items-start gap-3">
            <div className="flex-1 min-w-0 space-y-1.5">
              <SkeletonBar className="h-[10.5px] w-[88px]" />
              <SkeletonBar className="h-[26px] w-[70%]" />
              <SkeletonBar className="h-[12px] w-[44%]" />
            </div>
            <div className="flex pt-1 shrink-0">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-[34px] h-[34px] rounded-full border-2 border-surface bg-tile"
                  style={{ marginLeft: i === 0 ? 0 : -8 }}
                />
              ))}
            </div>
          </div>

          <div className="my-3.5 border-t-[1.5px] border-dashed border-border" />

          <div className="flex">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className={[
                  'flex-1 flex flex-col items-center gap-[3px] py-1',
                  i < 2 ? 'border-r border-border' : '',
                ].join(' ')}
              >
                <SkeletonBar className="h-[20px] w-[36px]" />
                <SkeletonBar className="h-[9.5px] w-[44px]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Day selector chips */}
      <div className="px-4 pt-4 pb-2 flex gap-2 overflow-hidden">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="h-12 w-[60px] rounded-2xl bg-tile shrink-0" />
        ))}
      </div>

      {/* Day timeline */}
      <div className="mx-5 mt-5">
        <TimelineSkeleton embedded />
      </div>
    </PageSkeletonShell>
  )
}
