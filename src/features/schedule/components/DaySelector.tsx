// src/features/schedule/components/DaySelector.tsx
// Horizontally-scrolling day-picker chips above the timeline. Each chip
// shows Day{N} / day-of-month / weekday + a count badge when there are
// schedules on that date. Active day is filled accent; days with items
// are darker than empty days.
//
// Extracted from SchedulePage to keep the page focused on orchestration.
import { fromLocalDateString } from '@/utils/dates'
import type { Schedule } from '@/types'

interface Props {
  dateRange:    string[]                       // 'YYYY-MM-DD'
  display:      string | undefined             // active date
  grouped:      Record<string, Schedule[] | undefined>
  onSelectDay:  (date: string) => void
}

export default function DaySelector({ dateRange, display, grouped, onSelectDay }: Props) {
  return (
    <div className="mt-5">
      <div className="px-5 pb-0.5 flex items-center justify-between">
        <span className="text-[11px] font-bold text-muted tracking-[0.1em] uppercase">
          日程選択
        </span>
        <span className="text-[11px] text-muted">{dateRange.length} 日間</span>
      </div>

      <div className="flex gap-2 px-5 pt-2.5 pb-1 overflow-x-auto overflow-y-visible no-scrollbar">
        {dateRange.map((date, i) => {
          const active   = date === display
          const d        = fromLocalDateString(date)
          const dayItems = grouped[date] ?? []
          const hasItems = dayItems.length > 0
          return (
            <button
              key={date}
              onClick={() => onSelectDay(date)}
              aria-current={active ? 'date' : undefined}
              aria-label={`Day${i+1} ${date}${hasItems ? `（${dayItems.length}件）` : ''}`}
              className={[
                'shrink-0 relative flex flex-col items-center px-3 pt-2.5 pb-2 rounded-2xl cursor-pointer transition-all min-w-[52px] gap-0.5',
                active
                  ? 'border-0 bg-accent text-white'
                  : `border border-border bg-surface ${hasItems ? 'text-ink' : 'text-muted'}`,
                hasItems || active ? 'opacity-100' : 'opacity-65',
              ].join(' ')}
            >
              <span className="text-[8px] font-bold tracking-[0.08em] opacity-80 uppercase">
                Day{i+1}
              </span>
              <span className="text-[20px] font-black leading-none">
                {d.getDate()}
              </span>
              <span className="text-[8.5px] opacity-70">
                {d.toLocaleDateString('zh-TW', { weekday:'short' })}
              </span>
              {hasItems ? (
                <div
                  className={[
                    'absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-[5px] rounded-[9px] text-[10px] font-extrabold tracking-[0.02em] flex items-center justify-center border-2 border-app shadow-[0_2px_6px_rgba(0,0,0,0.12)] pointer-events-none',
                    active ? 'bg-white text-accent' : 'bg-teal text-white',
                  ].join(' ')}
                >
                  {dayItems.length}
                </div>
              ) : !active && (
                <div className="absolute -top-[3px] -right-[3px] w-2 h-2 rounded-full bg-dot border-2 border-app pointer-events-none" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
