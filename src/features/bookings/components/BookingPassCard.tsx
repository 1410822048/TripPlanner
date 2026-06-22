import {
  Building2,
  CalendarDays,
  FileText,
  Hash,
  Image as ImageIcon,
  MapPin,
} from 'lucide-react'
import type { Booking } from '@/types'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import {
  attachmentThumbPath,
  bookingDisplayName,
  bookingSubtitle,
  BOOKING_TYPE_META,
  isImageAttachment,
} from '../utils'
import { fmtDate, fmtTime, nightsBetween } from './cards/dateFormat'
import { bookingPassHeroChrome, bookingPassTheme, colorWithAlpha } from './bookingPassTheme'
import BookingBrandPill from './BookingBrandPill'

interface Props {
  booking: Booking
  whenLabel: string
}

function dateTimeLabel(value: string | undefined): string {
  const date = fmtDate(value)
  const time = fmtTime(value)
  if (!date) return ''
  return time ? `${date} ${time}` : date
}

export default function BookingPassCard({ booking, whenLabel }: Props) {
  if (booking.type === 'hotel') {
    return <HotelPassCard booking={booking} whenLabel={whenLabel} />
  }
  return <StandardPassCard booking={booking} whenLabel={whenLabel} />
}

function StandardPassCard({ booking, whenLabel }: Props) {
  const TypeIcon = BOOKING_TYPE_META[booking.type].icon
  const theme = bookingPassTheme(booking)
  const hero = bookingPassHeroChrome(theme)
  const title = bookingDisplayName(booking)
  const subtitle = bookingSubtitle(booking)
  const dateLabel = dateTimeLabel(booking.checkIn) || whenLabel
  const hasAttachment = !!booking.attachment?.filePath
  const attachmentIsImage = isImageAttachment(booking.attachment)
  const facts = [
    dateLabel ? { label: '日時', value: dateLabel, icon: CalendarDays } : null,
    booking.confirmationCode ? { label: '確認番号', value: booking.confirmationCode, icon: Hash, mono: true } : null,
    booking.provider && !subtitle ? { label: '事業者', value: booking.provider, icon: Building2 } : null,
  ].filter(Boolean).slice(0, 3) as PassFact[]

  return (
    <div className="relative overflow-hidden bg-surface">
      <div
        className="px-4 pt-3.5 pb-4"
        style={{
          background: hero.background,
          color: hero.color,
          borderTop: hero.borderTop,
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={[
                'text-[10px] font-black uppercase',
                hero.isBranded
                  ? 'rounded-full bg-white/70 px-2 py-0.5 text-muted shadow-[0_2px_8px_rgba(0,0,0,0.06)]'
                  : 'opacity-80',
              ].join(' ')}>
                {BOOKING_TYPE_META[booking.type].label}
              </span>
              <BookingBrandPill theme={theme} variant={hero.isBranded ? 'soft' : 'light'} />
              {hasAttachment && <AttachmentIndicator isImage={attachmentIsImage} />}
            </div>
            <div className="mt-2 text-[21px] font-black leading-none truncate">
              {title}
            </div>
            {subtitle && (
              <div className={[
                'mt-2 text-[12px] font-bold truncate',
                hero.isBranded ? 'text-muted' : 'opacity-85',
              ].join(' ')}>
                {subtitle}
              </div>
            )}
          </div>
          <div
            className="w-11 h-11 rounded-input bg-white/20 backdrop-blur-sm shrink-0 flex items-center justify-center"
            style={theme.brand ? { backgroundColor: theme.accent, color: theme.accentInk } : undefined}
          >
            <TypeIcon size={22} strokeWidth={1.9} />
          </div>
        </div>
      </div>

      <PassSeam />

      <div className="px-4 pt-3 pb-3">
        {facts.length > 0 ? (
          <div className="grid grid-cols-3 gap-3">
            {facts.map(fact => <PassFactCell key={fact.label} fact={fact} />)}
          </div>
        ) : (
          <div className="text-[12px] font-semibold text-muted">
            詳細を表示
          </div>
        )}
      </div>
    </div>
  )
}

function HotelPassCard({ booking, whenLabel }: Props) {
  const TypeIcon = BOOKING_TYPE_META.hotel.icon
  const theme = bookingPassTheme(booking)
  const hero = bookingPassHeroChrome(theme)
  const title = bookingDisplayName(booking)
  const isImage = isImageAttachment(booking.attachment)
  const coverSrc = useAttachmentUrl(isImage ? attachmentThumbPath(booking.attachment) : undefined, { kind: 'thumb' })
  const checkInLabel = dateTimeLabel(booking.checkIn) || whenLabel
  const checkOutLabel = dateTimeLabel(booking.checkOut)
  const nights = nightsBetween(booking.checkIn, booking.checkOut)
  const hasAttachment = !!booking.attachment?.filePath
  const coverText = coverSrc ? 'text-white' : ''

  return (
    <div className="relative overflow-hidden bg-surface">
      <div
        className={['relative h-[154px] overflow-hidden', coverText].join(' ')}
        style={{
          ...(!coverSrc ? { background: hero.background, color: hero.color, borderTop: hero.borderTop } : undefined),
          boxShadow: theme.brand && coverSrc ? `inset 0 3px 0 ${theme.accent}` : undefined,
        }}
      >
        {coverSrc ? (
          <>
            <img
              src={coverSrc}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-black/25" />
          </>
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center text-ink/25"
            style={theme.brand ? { color: colorWithAlpha(theme.accent, '38') } : undefined}
          >
            <TypeIcon size={48} strokeWidth={1.4} />
          </div>
        )}

        <div className="absolute left-3 top-3 flex max-w-[calc(100%-96px)] items-center gap-1.5">
          <span className={[
            'rounded-full px-2.5 py-1 text-[10.5px] font-black shadow-[0_4px_12px_rgba(0,0,0,0.12)]',
            coverSrc || !hero.isBranded ? 'bg-white/90 text-ink' : 'bg-white/70 text-muted',
          ].join(' ')}>
            ホテル
          </span>
          <BookingBrandPill theme={theme} variant={coverSrc || !hero.isBranded ? 'light' : 'soft'} />
          {hasAttachment && <AttachmentIndicator isImage={isImage} />}
        </div>
        {nights !== null && (
          <div className="absolute right-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[10.5px] font-black text-white backdrop-blur-sm">
            {nights}泊
          </div>
        )}

        <div className="absolute inset-x-4 bottom-3">
          <div className="text-[20px] font-black leading-tight truncate">
            {title}
          </div>
          {booking.address && (
            <div className="mt-1 flex items-center gap-1 text-[11.5px] font-bold opacity-90 truncate">
              <MapPin size={12} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{booking.address}</span>
            </div>
          )}
        </div>
      </div>

      <PassSeam />

      <div className="px-4 pt-3 pb-3">
        <div className="grid grid-cols-3 gap-3">
          {checkInLabel && (
            <PassFactCell fact={{ label: 'Check-in', value: checkInLabel, icon: CalendarDays }} />
          )}
          {checkOutLabel && (
            <PassFactCell fact={{ label: 'Check-out', value: checkOutLabel, icon: CalendarDays }} />
          )}
          {booking.confirmationCode ? (
            <PassFactCell fact={{ label: '確認番号', value: booking.confirmationCode, icon: Hash, mono: true }} />
          ) : (
            <PassFactCell fact={{ label: '予約', value: '詳細', icon: Building2 }} />
          )}
        </div>
      </div>
    </div>
  )
}

function PassSeam() {
  return (
    <div className="relative h-4 bg-surface">
      <div className="absolute inset-x-4 top-1/2 border-t border-dashed border-border" />
      <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-app border border-border" />
      <div className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-app border border-border" />
    </div>
  )
}

interface PassFact {
  label: string
  value: string
  icon: typeof CalendarDays
  mono?: boolean
}

function AttachmentIndicator({ isImage }: { isImage: boolean }) {
  const Icon = isImage ? ImageIcon : FileText
  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/85 text-muted shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
      role="img"
      aria-label="添付あり"
      title="添付あり"
    >
      <Icon size={12} strokeWidth={2.2} aria-hidden="true" />
    </span>
  )
}

function PassFactCell({ fact }: { fact: PassFact }) {
  const Icon = fact.icon
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[9.5px] font-black text-muted">
        <Icon size={10} strokeWidth={2} className="shrink-0" />
        <span className="truncate">{fact.label}</span>
      </div>
      <div className={[
        'mt-1 text-[11.5px] font-bold text-ink leading-snug truncate',
        fact.mono ? 'font-mono tabular-nums' : '',
      ].join(' ')}>
        {fact.value}
      </div>
    </div>
  )
}
