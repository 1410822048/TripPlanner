// src/features/schedule/components/DayTimeline.tsx
// Renders the schedule cards for a single day plus the "add" affordance.
// Three states:
//   - loading (cloud mode, fetching) → spinner
//   - empty                          → empty card with primary CTA
//   - has items                      → timeline + dashed ghost CTA
//
// Extracted from SchedulePage to keep the page focused on orchestration.
import { memo } from 'react'
import { Plus } from 'lucide-react'
import LoadingText from '@/components/ui/LoadingText'
import TimelineCard from './TimelineCard'
import type { Schedule } from '@/types'

interface Props {
  display:    string | undefined        // active 'YYYY-MM-DD'
  items:      Schedule[]
  dayTotal:   number                    // sum of estimatedCost for items
  isLoading:  boolean
  onAdd:      () => void
  onEdit:     (s: Schedule) => void
}

function DayTimeline({
  display, items, dayTotal, isLoading, onAdd, onEdit,
}: Props) {
  return (
    <div className="mx-5 mt-5">
      {display && (
        <div className="flex justify-between items-center mb-3.5">
          <div>
            <span className="text-[15px] font-bold text-ink">
              {new Date(display).toLocaleDateString('zh-TW', { month:'long', day:'numeric' })}
            </span>
            <span className="text-[12px] text-muted ml-1.5">
              {new Date(display).toLocaleDateString('zh-TW', { weekday:'long' })}
            </span>
          </div>
          {dayTotal > 0 && (
            <div className="bg-[#F2EAE0] text-[#906848] text-[11px] font-semibold px-2.5 py-1 rounded-card">
              合計 ¥{dayTotal.toLocaleString()}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-dot text-[13px]">
          <LoadingText />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
          <div className="text-[40px] mb-1.5 opacity-55">🗓</div>
          <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
            この日の予定はまだありません
          </p>
          <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
            さあ、最初の行程を追加しましょう
          </p>
          <button
            onClick={onAdd}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
            style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
          >
            <Plus size={14} strokeWidth={2.5} />
            行程を追加
          </button>
        </div>
      ) : (
        <>
          {items.map((s, idx) => (
            <TimelineCard
              key={s.id}
              s={s}
              isLast={idx === items.length - 1}
              onEdit={() => onEdit(s)}
            />
          ))}

          <div className="flex mt-2.5">
            <div className="w-12 shrink-0" />
            <button
              onClick={onAdd}
              className="flex-1 h-11 rounded-chip border-[1.5px] border-dashed border-border bg-transparent text-muted text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
            >
              <Plus size={14} strokeWidth={2} />
              行程を追加
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Memoised with custom comparator: ignore inline callback props
// (onAdd, onEdit have fresh identity each render). The data props
// drive output; items array comes from the memoised `grouped` map in
// SchedulePage so unchanged days have stable identity.
export default memo(DayTimeline, (prev, next) => (
  prev.display === next.display &&
  prev.items === next.items &&
  prev.dayTotal === next.dayTotal &&
  prev.isLoading === next.isLoading
))
