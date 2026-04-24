// src/features/schedule/components/TripHeaderCard.tsx
// The "card" block at the top of SchedulePage: trip title + destination +
// stacked member avatars + divider + stats row (日数 / 景點數 / 預估費).
// Extracted so SchedulePage's main body reads as a page orchestrator rather
// than a pile of JSX. The card itself has no data dependencies beyond the
// props passed in — all derived values (dateRange length, schedule count,
// total cost) are computed by the caller.
import { Pencil } from 'lucide-react'
import type { TripItem } from '../types'

interface Props {
  selectedTrip: TripItem
  tripDays:     number
  scheduleCount: number
  tripTotal:    number
  onEditTrip:   () => void
  onInvite:     () => void
}

export default function TripHeaderCard({
  selectedTrip, tripDays, scheduleCount, tripTotal,
  onEditTrip, onInvite,
}: Props) {
  const stats = [
    { value: `${tripDays}`,                    unit: '日', label: '旅行天數' },
    { value: `${scheduleCount}`,               unit: '個', label: '行程景點' },
    { value: `¥${tripTotal.toLocaleString()}`, unit: '',   label: '預估總費' },
  ] as const

  return (
    <div className="px-4">
      <div className="bg-surface border border-border rounded-[22px] px-4.5 pt-4.5 pb-4 shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
        <div className="flex justify-between items-start gap-3">
          <button
            onClick={onEditTrip}
            className="flex-1 min-w-0 block text-left bg-transparent border-none px-2 py-1.5 -mx-2 -my-1.5 rounded-xl cursor-pointer transition-colors hover:bg-app"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <p className="m-0 mb-[5px] text-[10.5px] font-semibold text-muted tracking-[0.12em] uppercase">
              {new Date(selectedTrip.startDate).getFullYear()} · 旅の記録
            </p>
            <div className="flex items-center gap-1.5 mb-[5px]">
              <h1 className="m-0 text-[26px] font-black text-teal -tracking-[0.5px] leading-[1.1]">
                {selectedTrip.title}
              </h1>
              <Pencil size={13} strokeWidth={2} className="opacity-45 shrink-0 mt-1 text-teal" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[12px] text-teal">✈</span>
              <span className="text-[12px] text-teal font-medium tracking-[0.04em] overflow-hidden text-ellipsis whitespace-nowrap">
                {selectedTrip.dest}
              </span>
            </div>
          </button>

          {/* Stacked avatars + invite "+" button */}
          <div className="flex pt-1 shrink-0">
            {selectedTrip.members.map((m, i) => (
              <div
                key={m.id}
                className="w-[34px] h-[34px] rounded-full border-2 border-surface relative flex items-center justify-center text-[11px] font-bold shadow-[0_1px_4px_rgba(0,0,0,0.1)]"
                style={{
                  background: m.bg,
                  color: m.color,
                  marginLeft: i === 0 ? 0 : '-8px',
                  zIndex: selectedTrip.members.length - i,
                }}
              >
                {m.label}
              </div>
            ))}
            <button
              onClick={onInvite}
              aria-label="メンバーを招待"
              className="w-[34px] h-[34px] rounded-full bg-app text-muted border-2 border-surface -ml-2 relative flex items-center justify-center text-[15px] font-light shadow-[0_1px_4px_rgba(0,0,0,0.06)] cursor-pointer transition-colors hover:bg-accent-pale hover:text-accent hover:border-accent/30"
              style={{ zIndex: 0 }}
            >
              +
            </button>
          </div>
        </div>

        <div className="my-3.5 border-t-[1.5px] border-dashed border-border" />

        <div className="flex">
          {stats.map(({ value, unit, label }, i) => (
            <div
              key={label}
              className={[
                'flex-1 flex flex-col items-center gap-[3px] py-1',
                i < stats.length - 1 ? 'border-r border-border' : '',
              ].join(' ')}
            >
              <div className="flex items-baseline gap-px">
                <span className="text-[20px] font-extrabold text-ink -tracking-[0.5px]">
                  {value}
                </span>
                {unit && <span className="text-[11px] font-semibold text-muted ml-px">{unit}</span>}
              </div>
              <span className="text-[9.5px] text-muted tracking-[0.06em]">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
