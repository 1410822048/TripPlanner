// src/features/schedule/components/DayTimeline.tsx
// Renders the schedule cards for a single day plus the "add" affordance.
// Three states: loading skeleton / empty card with CTA / timeline + add row.
import { Plus } from 'lucide-react'
import TimelineSkeleton from './TimelineSkeleton'
import TimelineCard from './TimelineCard'
import type { Schedule } from '@/types'
import { formatMinorAmount } from '@/utils/money'

interface Props {
  display:    string | undefined        // active 'YYYY-MM-DD'
  items:      Schedule[]
  dayTotal:   number                    // sum of estimatedCostMinor for items (integer minor units)
  isLoading:  boolean
  /** Owner / editor — controls visibility of add affordances. Viewers
   *  see the timeline but no add buttons (mirrors firestore.rules
   *  canWrite gating on the schedules subcollection). */
  canWrite:   boolean
  /** ISO currency code of the active trip — passed in (rather than
   *  hooked via useTripCurrency) so the memo comparator below includes
   *  it. Without that the daily total + per-card costs would stay in
   *  the old symbol after the user changes currency. */
  currency:   string
  onAdd:      () => void
  onOpenDetails: (s: Schedule) => void
}

function DayTimeline({
  display, items, dayTotal, isLoading, canWrite, currency, onAdd, onOpenDetails,
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
            <div className="bg-[#F2EAE0] text-[#906848] text-[11px] font-semibold px-2.5 py-1 rounded-card tabular-nums">
              合計 {formatMinorAmount(dayTotal, currency)}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <TimelineSkeleton />
      ) : items.length === 0 ? (
        <div className="text-center px-6 py-10 pb-8 bg-surface rounded-card border-[1.5px] border-dashed border-border">
          <div className="text-[40px] mb-1.5 opacity-55">🗓</div>
          <p className="m-0 mb-1 text-[13.5px] font-semibold text-ink tracking-[0.02em]">
            この日の予定はまだありません
          </p>
          <p className="m-0 mb-[18px] text-[11.5px] text-muted tracking-[0.04em]">
            {canWrite
              ? 'さあ、最初の行程を追加しましょう'
              : '閲覧者として参加中です。行程の追加はオーナー / 編集者のみ行えます。'}
          </p>
          {canWrite && (
            <button
              onClick={onAdd}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
              style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
            >
              <Plus size={14} strokeWidth={2.5} />
              行程を追加
            </button>
          )}
        </div>
      ) : (
        <>
          {items.map((s, idx) => (
            <TimelineCard
              key={s.id}
              s={s}
              isLast={idx === items.length - 1}
              currency={currency}
              onOpenDetails={() => onOpenDetails(s)}
            />
          ))}

          {canWrite && (
            <div className="mt-2.5 pl-[26px]">
              <button
                onClick={onAdd}
                className="w-full h-11 rounded-chip border-[1.5px] border-dashed border-border bg-transparent text-muted text-[13px] font-medium flex items-center justify-center gap-1.5 cursor-pointer tracking-[0.04em] transition-all hover:bg-teal-pale hover:border-teal hover:text-teal"
              >
                <Plus size={14} strokeWidth={2} />
                行程を追加
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default DayTimeline
