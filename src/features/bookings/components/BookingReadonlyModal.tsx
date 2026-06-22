import {
  Building2,
  CalendarDays,
  ExternalLink,
  FileText,
  Hash,
  Image as ImageIcon,
  MapPin,
  Pencil,
  Route,
  type LucideIcon,
} from 'lucide-react'
import type { Booking } from '@/types'
import BottomSheet from '@/components/ui/BottomSheet'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { addressMapHref } from '@/utils/maps'
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
  isOpen: boolean
  booking: Booking
  onClose: () => void
  onEdit?: () => void
  onPreviewAttachment: (booking: Booking) => void
}

interface DetailRowData {
  icon: LucideIcon
  label: string
  value: string
  mono?: boolean
}

function dateTimeLabel(value: string | undefined): string {
  const date = fmtDate(value)
  const time = fmtTime(value)
  if (!date) return ''
  return time ? `${date} ${time}` : date
}

function fileLabel(path: string | undefined): string {
  return path?.split('/').pop() ?? 'attachment'
}

export default function BookingReadonlyModal({
  isOpen,
  booking,
  onClose,
  onEdit,
  onPreviewAttachment,
}: Props) {
  const TypeIcon = BOOKING_TYPE_META[booking.type].icon
  const typeLabel = BOOKING_TYPE_META[booking.type].label
  const theme = bookingPassTheme(booking)
  const hero = bookingPassHeroChrome(theme)
  const title = bookingDisplayName(booking)
  const subtitle = bookingSubtitle(booking)
  const mapHref = addressMapHref(booking.address)
  const attachment = booking.attachment
  const attachmentIsImage = isImageAttachment(attachment)
  const attachmentThumb = useAttachmentUrl(
    attachmentIsImage ? attachmentThumbPath(attachment) : undefined,
    { kind: 'thumb' },
  )
  const headerImage = booking.type === 'hotel' && attachmentIsImage ? attachmentThumb : null
  const heroIsTall = booking.type === 'hotel'
  const checkInLabel = dateTimeLabel(booking.checkIn)
  const checkOutLabel = dateTimeLabel(booking.checkOut)
  const nights = nightsBetween(booking.checkIn, booking.checkOut)
  const hasRoute = !!booking.origin || !!booking.destination
  const infoRows = [
    booking.type !== 'hotel' && checkInLabel
      ? { icon: CalendarDays, label: '日時', value: checkInLabel }
      : null,
    booking.type !== 'hotel' && checkOutLabel
      ? { icon: CalendarDays, label: '終了', value: checkOutLabel }
      : null,
    booking.provider
      ? { icon: Building2, label: '事業者', value: booking.provider }
      : null,
    booking.confirmationCode
      ? { icon: Hash, label: '確認番号', value: booking.confirmationCode, mono: true }
      : null,
    booking.address
      ? { icon: MapPin, label: '住所', value: booking.address }
      : null,
  ].filter(Boolean) as DetailRowData[]

  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="予約詳細"
      footer={onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="w-full h-12 rounded-chip border-none bg-teal text-white text-[14px] font-bold flex items-center justify-center gap-2 cursor-pointer transition-transform active:scale-[0.99]"
          style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
        >
          <Pencil size={15} strokeWidth={2.3} />
          編集
        </button>
      ) : undefined}
    >
      <div className="space-y-3">
        <section className="overflow-hidden rounded-card border border-border bg-surface shadow-[0_10px_28px_rgba(32,42,45,0.08)]">
          <div
            className={[
              'relative overflow-hidden p-4',
              heroIsTall ? 'min-h-[176px]' : '',
              headerImage ? 'text-white' : '',
            ].join(' ')}
            style={!headerImage ? {
              background: hero.background,
              color: hero.color,
              borderTop: hero.borderTop,
            } : undefined}
          >
            {headerImage && (
              <>
                <img
                  src={headerImage}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/20 to-black/35" />
              </>
            )}

            <div className="relative z-10 flex min-h-[112px] flex-col justify-between gap-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={[
                      'inline-flex rounded-full px-2 py-0.5 text-[10px] font-black',
                      headerImage ? 'bg-white/90 text-ink' : hero.isBranded ? 'bg-white/70 text-muted' : 'bg-white/20 text-current',
                    ].join(' ')}>
                      {typeLabel}
                    </span>
                    <BookingBrandPill theme={theme} variant={headerImage || !hero.isBranded ? 'light' : 'soft'} />
                    {nights !== null && (
                      <span className={[
                        'inline-flex rounded-full px-2 py-0.5 text-[10px] font-black',
                        headerImage ? 'bg-black/45 text-white backdrop-blur-sm' : hero.isBranded ? 'bg-white/70 text-muted' : 'bg-white/20 text-current',
                      ].join(' ')}>
                        {nights}泊
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-[22px] font-black leading-[1.08] break-words">
                    {title}
                  </div>
                  {subtitle && (
                    <div className="mt-2 text-[12px] font-bold opacity-85 truncate">
                      {subtitle}
                    </div>
                  )}
                </div>
                <div
                  className="w-12 h-12 rounded-[18px] shrink-0 flex items-center justify-center shadow-[0_8px_20px_rgba(0,0,0,0.14)]"
                  style={{ backgroundColor: theme.accent, color: theme.accentInk }}
                >
                  <TypeIcon size={23} strokeWidth={1.9} />
                </div>
              </div>
            </div>
          </div>

          {booking.type === 'hotel' && (checkInLabel || checkOutLabel) ? (
            <StayTimeline
              start={checkInLabel || '—'}
              end={checkOutLabel || '—'}
              accent={theme.accent}
            />
          ) : hasRoute ? (
            <RouteTimeline
              origin={booking.origin || '—'}
              destination={booking.destination || '—'}
              accent={theme.accent}
            />
          ) : null}
        </section>

        {(mapHref || booking.link) && (
          <section className="grid grid-cols-2 gap-2">
            {mapHref && (
              <ActionLink
                href={mapHref}
                icon={MapPin}
                label="地図"
                ariaLabel={`${booking.address ?? ''} を地図で開く`}
                accent={theme.accent}
                fullWidth={!booking.link}
              />
            )}
            {/* link は書き込み時に http(s) のみ検証済み(Zod / Worker /
                rules)なので href に出して安全。ActionLink は
                rel="noopener noreferrer"。 */}
            {booking.link && (
              <ActionLink
                href={booking.link}
                icon={ExternalLink}
                label="予約ページ"
                ariaLabel="予約ページを開く"
                accent={theme.accent}
                fullWidth={!mapHref}
              />
            )}
          </section>
        )}

        {infoRows.length > 0 && (
          <section className="overflow-hidden rounded-card border border-border bg-surface">
            {infoRows.map(row => (
              <DetailRow key={row.label} row={row} accent={theme.accent} />
            ))}
          </section>
        )}

        {booking.note && (
          <section className="rounded-card border border-border bg-surface px-4 py-3">
            <div className="text-[10px] font-black text-muted">
              メモ
            </div>
            <div className="mt-2 text-[12.5px] leading-6 text-ink whitespace-pre-wrap break-words">
              {booking.note}
            </div>
          </section>
        )}

        {attachment && (
          <section>
            <button
              type="button"
              onClick={() => onPreviewAttachment(booking)}
              aria-label={`添付を表示: ${fileLabel(attachment.filePath)}`}
              className={`${actionClassName()} w-full cursor-pointer`}
              style={actionStyle(theme.accent)}
            >
              {attachmentIsImage ? <ImageIcon size={15} strokeWidth={2.2} /> : <FileText size={15} strokeWidth={2.2} />}
              <span className="text-[12.5px] font-bold">添付を表示</span>
            </button>
          </section>
        )}
      </div>
    </BottomSheet>
  )
}

function StayTimeline({
  start,
  end,
  accent,
}: {
  start: string
  end: string
  accent: string
}) {
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <TimelinePoint label="Check-in" value={start} />
        <div className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: accent }} />
          <span className="w-9 border-t border-dashed border-border" />
          <span className="w-2 h-2 rounded-full bg-border" />
        </div>
        <TimelinePoint label="Check-out" value={end} align="right" />
      </div>
    </div>
  )
}

function RouteTimeline({
  origin,
  destination,
  accent,
}: {
  origin: string
  destination: string
  accent: string
}) {
  return (
    <div className="border-t border-border px-4 py-3">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <TimelinePoint label="出発" value={origin} />
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ backgroundColor: colorWithAlpha(accent, '18'), color: accent }}
        >
          <Route size={17} strokeWidth={2.2} />
        </div>
        <TimelinePoint label="到着" value={destination} align="right" />
      </div>
    </div>
  )
}

function TimelinePoint({
  label,
  value,
  align = 'left',
}: {
  label: string
  value: string
  align?: 'left' | 'right'
}) {
  return (
    <div className={['min-w-0', align === 'right' ? 'text-right' : ''].join(' ')}>
      <div className="text-[10px] font-black text-muted">
        {label}
      </div>
      <div className="mt-1 text-[13px] font-bold text-ink leading-snug break-words">
        {value}
      </div>
    </div>
  )
}

function DetailRow({ row, accent }: { row: DetailRowData; accent: string }) {
  const Icon = row.icon
  return (
    <div className="flex items-start gap-3 border-b border-border last:border-b-0 px-4 py-3">
      <div
        className="mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0"
        style={{ backgroundColor: colorWithAlpha(accent, '14'), color: accent }}
      >
        <Icon size={15} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-black text-muted">
          {row.label}
        </div>
        <div className={[
          'mt-1 text-[13px] font-bold text-ink break-words',
          row.mono ? 'font-mono tabular-nums' : '',
        ].join(' ')}>
          {row.value}
        </div>
      </div>
    </div>
  )
}

function ActionLink({
  href,
  icon: Icon,
  label,
  ariaLabel,
  accent,
  fullWidth = false,
}: {
  href: string
  icon: LucideIcon
  label: string
  ariaLabel: string
  accent: string
  fullWidth?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      aria-label={ariaLabel}
      className={actionClassName(fullWidth)}
      style={actionStyle(accent)}
    >
      <Icon size={15} strokeWidth={2.2} />
      <span className="text-[12.5px] font-bold">{label}</span>
    </a>
  )
}

function actionClassName(fullWidth = false) {
  return [
    'min-h-11 rounded-[14px] border no-underline flex items-center justify-center gap-1.5 px-3 transition-colors',
    fullWidth ? 'col-span-2' : '',
  ].join(' ')
}

function actionStyle(accent: string) {
  return {
    backgroundColor: colorWithAlpha(accent, '14'),
    borderColor: colorWithAlpha(accent, '28'),
    color: accent,
  }
}
