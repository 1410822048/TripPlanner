// src/features/bookings/components/BookingPdfAutofillCard.tsx
// The "read a booking PDF" entry point, its status line, and the picker
// shown when one PDF yields several bookings (a round trip, a multi-leg
// itinerary). Presentational: every decision lives in
// useBookingPdfAutofill.
//
// Create-mode only — the modal doesn't render it while editing.
import { CalendarDays, ChevronRight, FileText, Loader2, RefreshCw } from 'lucide-react'
import { BOOKING_TYPE_META } from '../utils'
import type { BookingPdfAutofill } from '../hooks/useBookingPdfAutofill'

export default function BookingPdfAutofillCard({ pdf }: { pdf: BookingPdfAutofill }) {
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-card border border-accent/20 bg-surface shadow-[0_8px_22px_rgba(32,42,45,0.07)]">
        <div className="flex items-center gap-2 bg-accent-pale/70 px-3 py-3">
          <button
            type="button"
            onClick={pdf.onCardClick}
            disabled={pdf.isLoading}
            className="group flex min-w-0 flex-1 items-center gap-3 text-left text-accent transition-colors hover:text-accent-pressed disabled:cursor-wait disabled:opacity-70"
          >
            <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-input bg-accent text-white shadow-[0_4px_10px_rgba(74,102,112,0.22)]">
              {pdf.isLoading ? (
                <Loader2 size={18} strokeWidth={2} className="animate-spin" />
              ) : (
                <>
                  <FileText size={18} strokeWidth={2} />
                  <span aria-hidden="true" className="absolute -bottom-1 rounded-[5px] bg-surface px-1 py-px text-[7px] font-black leading-none text-accent shadow-[0_1px_4px_rgba(0,0,0,0.12)]">
                    PDF
                  </span>
                </>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-black uppercase leading-[1.15] tracking-[0.14em] text-pick">
                Automatic import
              </span>
              <span className="mt-0.5 block text-[15px] font-black leading-[1.25] text-accent">
                {pdf.buttonLabel}
              </span>
            </span>
            <ChevronRight size={18} strokeWidth={2.2} className="shrink-0 opacity-80 transition-transform group-hover:translate-x-0.5" />
          </button>
          {pdf.sourceFile && pdf.hasAnalyzed && (
            <button
              type="button"
              onClick={pdf.onRerunClick}
              disabled={pdf.isLoading}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-chip px-2.5 text-[12px] font-bold text-pick transition-colors hover:bg-surface/80 hover:text-accent disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCw size={13} strokeWidth={2.3} />
              <span>重新讀取</span>
            </button>
          )}
        </div>
        {(pdf.showStatus || pdf.sourceFile) && (
          <div className="border-t border-accent/10 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              {pdf.showStatus ? (
                <div
                  role="status"
                  aria-live="polite"
                  className={[
                    'flex min-w-0 flex-1 items-center gap-2 text-[12px] font-bold leading-[1.35]',
                    pdf.status === 'error'
                      ? 'text-danger'
                      : pdf.status === 'applied'
                        ? 'text-teal'
                        : 'text-muted',
                  ].join(' ')}
                >
                  <span aria-hidden="true" className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center">
                    {pdf.status === 'applied' ? (
                      <>
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-35" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-teal" />
                      </>
                    ) : (
                      <span className={[
                        'inline-flex h-2.5 w-2.5 rounded-full',
                        pdf.status === 'error' ? 'bg-danger' : 'bg-dot',
                      ].join(' ')}
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">{pdf.message}</span>
                </div>
              ) : (
                <span className="min-w-0 truncate text-[12px] font-medium text-muted">
                  {pdf.sourceFile?.name}
                </span>
              )}
              {pdf.sourceFile && !pdf.hasAnalyzed && (
                <button
                  type="button"
                  onClick={pdf.pickAnother}
                  className="shrink-0 text-[12px] font-bold text-accent"
                >
                  選擇其他 PDF
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {pdf.candidates.length > 0 && (
        <div className="space-y-2">
          <div className="space-y-2.5">
            {pdf.candidates.map(({ candidate, index, input }) => {
              const typeMeta = BOOKING_TYPE_META[input.type]
              const TypeIcon = typeMeta.icon
              const roleLabel = pdf.candidateRoleLabel(candidate, index)
              const originText = input.origin?.trim() || input.title?.trim() || typeMeta.label
              const destinationText = input.destination?.trim() || input.address?.trim() || input.provider?.trim() || typeMeta.label
              const detailText = [input.provider?.trim(), input.title?.trim()].filter(Boolean).join(' ')
              const dateText = input.checkIn?.trim()

              return (
                <label
                  key={`${candidate.segmentRole}-${index}`}
                  className="grid w-full grid-cols-[auto_1fr] items-center gap-3 rounded-card border border-border bg-surface px-3 py-3 text-left shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-colors hover:border-accent/45 hover:bg-accent-pale/35"
                >
                  <input
                    type="checkbox"
                    checked={pdf.selectedIndexes.includes(index)}
                    onChange={() => pdf.toggleCandidate(index)}
                    className="h-4 w-4 shrink-0 accent-accent"
                  />
                  <span className="min-w-0 space-y-2">
                    <span className="flex min-w-0 items-start justify-between gap-2">
                      <span className="rounded-full bg-pick-pale px-2 py-0.5 text-[10px] font-black leading-none text-pick">
                        {roleLabel}
                      </span>
                      {detailText && (
                        <span className="min-w-0 truncate text-right text-[10px] font-bold leading-[1.2] text-pick">
                          {detailText}
                        </span>
                      )}
                    </span>
                    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                      <span className="truncate text-[13px] font-black leading-[1.25] text-ink">
                        {originText}
                      </span>
                      <TypeIcon size={14} strokeWidth={2.2} className="text-dot" />
                      <span className="truncate text-right text-[13px] font-black leading-[1.25] text-ink">
                        {destinationText}
                      </span>
                    </span>
                    {dateText && (
                      <span className="flex items-center gap-1 text-[11px] font-semibold leading-none text-muted">
                        <CalendarDays size={12} strokeWidth={2} />
                        {dateText}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
          <button
            type="button"
            onClick={pdf.createSelected}
            disabled={!pdf.hasSelectedCandidate || pdf.isLoading}
            className="inline-flex h-10 w-full items-center justify-center rounded-chip bg-accent px-3 text-[13px] font-black text-white transition-colors hover:bg-accent-pressed disabled:cursor-not-allowed disabled:opacity-55"
          >
            新增選取的訂單
          </button>
        </div>
      )}
    </div>
  )
}
