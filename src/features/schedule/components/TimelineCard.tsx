// src/features/schedule/components/TimelineCard.tsx
import {
  Clock, MapPin, Pencil,
  Utensils, Bus, Hotel, ShoppingBag, Star,
} from 'lucide-react'
import type { Schedule, ScheduleCategory } from '@/types'

const CAT: Record<ScheduleCategory, { bg: string; color: string; Icon: React.ElementType }> = {
  transport:     { bg:'#E8EEF5', color:'#4A6FA0', Icon: Bus         },
  accommodation: { bg:'#F5EDE6', color:'#9A6840', Icon: Hotel       },
  food:          { bg:'#F5E8E8', color:'#9A4848', Icon: Utensils    },
  activity:      { bg:'#E6F2EC', color:'#3A7858', Icon: Star        },
  shopping:      { bg:'#F0E8F5', color:'#724888', Icon: ShoppingBag },
  other:         { bg:'#EBEBEB', color:'#707070', Icon: MapPin      },
}

interface Props {
  s:      Schedule
  isLast: boolean
  onEdit: () => void
}

export default function TimelineCard({ s, isLast, onEdit }: Props) {
  const cat  = CAT[s.category]
  const Icon = cat.Icon
  return (
    <div className="flex items-stretch">
      <div className="flex flex-col items-center w-12 shrink-0">
        <div
          className="w-[34px] h-[34px] rounded-input flex items-center justify-center shrink-0"
          style={{ background: cat.bg, color: cat.color }}
        >
          <Icon size={15} strokeWidth={2} />
        </div>
        {!isLast && (
          <div
            className="w-[1.5px] flex-1 min-h-3 mt-1"
            style={{
              background: `repeating-linear-gradient(to bottom, var(--color-dot) 0, var(--color-dot) 3px, transparent 3px, transparent 7px)`,
            }}
          />
        )}
      </div>

      <button
        type="button"
        onClick={onEdit}
        aria-label={`${s.title} を編集`}
        className={[
          'flex-1 flex items-center gap-2 bg-surface border border-border rounded-chip px-3.5 py-[11px] pr-3',
          'cursor-pointer text-left font-[inherit] text-[color:inherit] transition-colors',
          'hover:bg-[#F5F1EA] focus-visible:outline-2 focus-visible:outline-accent',
          'tap-highlight-transparent',
          isLast ? 'mb-0' : 'mb-2.5',
        ].join(' ')}
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start gap-2">
            <span className="text-[14px] font-semibold text-ink leading-[1.3]">
              {s.title}
            </span>
            {typeof s.estimatedCost === 'number' && s.estimatedCost > 0 && (
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded-card shrink-0 whitespace-nowrap"
                style={{ color: cat.color, background: cat.bg }}
              >
                ¥{s.estimatedCost.toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex gap-2.5 mt-[5px] flex-wrap">
            {s.startTime && (
              <span className="flex items-center gap-[3px] text-[11px] text-muted">
                <Clock size={10} strokeWidth={2} />
                {s.startTime}{s.endTime ? ` — ${s.endTime}` : ''}
              </span>
            )}
            {s.location?.name && (
              <span className="flex items-center gap-[3px] text-[11px] text-muted">
                <MapPin size={10} strokeWidth={2} />
                {s.location.name}
              </span>
            )}
          </div>
          {s.description && (
            <span className="block mt-[5px] text-[11.5px] text-[#AEA9A2] leading-[1.55]">
              {s.description}
            </span>
          )}
        </div>
        <Pencil size={12} color="#CCC8C0" strokeWidth={1.8} className="shrink-0" />
      </button>
    </div>
  )
}
