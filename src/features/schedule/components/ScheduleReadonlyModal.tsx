import {
  CalendarDays,
  Clock,
  FileText,
  MapPin,
  Pencil,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { Schedule } from '@/types'
import BottomSheet from '@/components/ui/BottomSheet'
import { CATEGORY_ICON, SCHEDULE_CATEGORY_LABEL, SCHEDULE_CATEGORY_STYLE } from '@/shared/categoryMeta'
import { fromLocalDateString } from '@/utils/dates'
import { addressMapHref } from '@/utils/maps'
import { formatMinorAmount } from '@/utils/money'

interface Props {
  isOpen:   boolean
  schedule: Schedule
  currency: string
  onClose:  () => void
  onEdit?:  () => void
}

function formatDate(date: string): string {
  return fromLocalDateString(date)
    .toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

function formatTime(schedule: Schedule): string {
  if (!schedule.startTime && !schedule.endTime) return '時間未定'
  if (schedule.startTime && schedule.endTime) return `${schedule.startTime} — ${schedule.endTime}`
  return schedule.startTime ?? schedule.endTime ?? '時間未定'
}

export default function ScheduleReadonlyModal({
  isOpen,
  schedule,
  currency,
  onClose,
  onEdit,
}: Props) {
  const CategoryIcon = CATEGORY_ICON[schedule.category]
  const style = SCHEDULE_CATEGORY_STYLE[schedule.category]
  const mapHref = addressMapHref(schedule.location?.address ?? schedule.location?.name)

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="行程詳情"
      footer={onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="w-full h-12 rounded-chip border-none bg-teal text-white text-[14px] font-bold tracking-[0.04em] flex items-center justify-center gap-2 cursor-pointer transition-transform active:scale-[0.99]"
          style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
        >
          <Pencil size={15} strokeWidth={2.3} />
          編輯
        </button>
      ) : undefined}
    >
      <section
        className="rounded-[20px] border bg-surface px-4 py-4"
        style={{ borderColor: style.color, boxShadow: '0 10px 26px rgba(32,42,45,0.06)' }}
      >
        <div className="flex items-start gap-3">
          <div
            className="w-12 h-12 rounded-[16px] shrink-0 flex items-center justify-center"
            style={{ background: style.bg, color: style.color }}
          >
            <CategoryIcon size={22} strokeWidth={1.9} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-black"
                style={{ background: style.bg, color: style.color }}
              >
                {SCHEDULE_CATEGORY_LABEL[schedule.category]}
              </span>
              <span className="text-[11px] font-semibold text-muted tabular-nums">
                {formatTime(schedule)}
              </span>
            </div>
            <h3 className="mt-2 m-0 text-[19px] font-black leading-snug text-ink break-words">
              {schedule.title}
            </h3>
            {schedule.location?.name && (
              <div className="mt-1.5 flex items-center gap-1 text-[12px] font-semibold text-muted min-w-0">
                <MapPin size={12} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{schedule.location.name}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-card border border-border bg-surface">
        <DetailRow icon={CalendarDays} label="日期" value={formatDate(schedule.date)} accent={style.color} />
        <DetailRow icon={Clock} label="時間" value={formatTime(schedule)} mono accent={style.color} />
        {schedule.location?.name && (
          <DetailRow icon={MapPin} label="地點" value={schedule.location.name} accent={style.color} />
        )}
        {typeof schedule.estimatedCostMinor === 'number' && schedule.estimatedCostMinor > 0 && (
          <DetailRow
            icon={Wallet}
            label="預算"
            value={formatMinorAmount(schedule.estimatedCostMinor, currency)}
            mono
            accent={style.color}
          />
        )}
      </section>

      {mapHref && (
        <a
          href={mapHref}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-11 rounded-[14px] border no-underline flex items-center justify-center gap-1.5 px-3"
          style={{
            background: style.bg,
            borderColor: style.color,
            color: style.color,
          }}
          aria-label={`在地圖中開啟 ${schedule.location?.name ?? ''}`}
        >
          <MapPin size={15} strokeWidth={2.2} />
          <span className="text-[12.5px] font-bold">地圖</span>
        </a>
      )}

      {schedule.description && (
        <section className="rounded-card border border-border bg-surface px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] font-black text-muted">
            <FileText size={12} strokeWidth={2} />
            備註
          </div>
          <div className="mt-2 text-[12.5px] leading-6 text-ink whitespace-pre-wrap break-words">
            {schedule.description}
          </div>
        </section>
      )}
    </BottomSheet>
  )
}

function DetailRow({
  icon: Icon,
  label,
  value,
  accent,
  mono = false,
}: {
  icon: LucideIcon
  label: string
  value: string
  accent: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border last:border-b-0 px-4 py-3">
      <div
        className="mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${accent}18`, color: accent }}
      >
        <Icon size={15} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-black text-muted">
          {label}
        </div>
        <div className={[
          'mt-1 text-[13px] font-bold text-ink break-words',
          mono ? 'font-mono tabular-nums' : '',
        ].join(' ')}>
          {value}
        </div>
      </div>
    </div>
  )
}
