// src/components/ui/pickers/DatePicker.tsx
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import PickerDialog from './PickerDialog'
import { PICKER_COLORS } from './constants'
import { fromLocalDateString } from '@/utils/dates'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const MONTHS   = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']

interface Props {
  value:       string        // 'YYYY-MM-DD'
  onChange:    (v: string) => void
  placeholder?: string
  error?:      boolean
  /**
   * Optional inclusive lower bound — dates before this are rendered
   * disabled (greyed + non-clickable). 'YYYY-MM-DD' format. Used by
   * ScheduleFormModal to keep schedule dates inside the trip's date
   * range.
   */
  minDate?:    string
  /** Optional inclusive upper bound. */
  maxDate?:    string
}

/** Imperative handle — lets a parent chain pickers (pick start → auto-open end). */
export interface DatePickerHandle {
  /**
   * Open the picker. `viewDate` ('YYYY-MM-DD') optionally sets which month
   * is displayed — used when chaining from start → end so the end picker
   * opens on the start's month instead of today.
   */
  open: (opts?: { viewDate?: string }) => void
}

const DatePicker = forwardRef<DatePickerHandle, Props>(function DatePicker(
  { value, onChange, placeholder = '日付を選択', error = false, minDate, maxDate },
  ref,
) {
  // Build a 'YYYY-MM-DD' from year/month/day for cheap lexicographic
  // bound comparison (no Date construction per cell).
  const isoFromYMD = (y: number, m: number, d: number): string =>
    `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const inRange = (iso: string): boolean => {
    if (minDate && iso < minDate) return false
    if (maxDate && iso > maxDate) return false
    return true
  }
  const today  = new Date()
  const parsed = value ? fromLocalDateString(value) : null

  // Default-view priority when picker opens with no selection:
  //   1. value (if set) — show the month containing it
  //   2. minDate (if set) — opening on a trip-locked picker should land
  //      inside the trip range, not on today (which is often months
  //      away from the trip dates)
  //   3. today
  // This keeps "open picker → see clickable days right away" — landing
  // on a fully-greyed-out month is a UX dead-end users have to scroll
  // through to find their range.
  const initialView = (() => {
    if (parsed) return { y: parsed.getFullYear(), m: parsed.getMonth() }
    if (minDate) {
      const min = fromLocalDateString(minDate)
      if (!Number.isNaN(min.getTime())) return { y: min.getFullYear(), m: min.getMonth() }
    }
    return { y: today.getFullYear(), m: today.getMonth() }
  })()

  const [open,      setOpen]      = useState(false)
  const [viewYear,  setViewYear]  = useState(initialView.y)
  const [viewMonth, setViewMonth] = useState(initialView.m)
  const [mode,      setMode]      = useState<'day' | 'month' | 'year'>('day')

  // Sync view to external value changes. Re-parse inside the effect
  // (instead of closing over the outer `parsed`) so `value` is the only
  // honest dependency — keeps React Compiler happy without an
  // eslint-disable. The outer `parsed` is recomputed every render
  // anyway, so this isn't extra work.
  useEffect(() => {
    if (!value) return
    const d = fromLocalDateString(value)
    if (Number.isNaN(d.getTime())) return
    setViewYear(d.getFullYear())
    setViewMonth(d.getMonth())
  }, [value])

  function openPicker(opts?: { viewDate?: string }) {
    if (opts?.viewDate) {
      const hint = fromLocalDateString(opts.viewDate)
      if (!isNaN(hint.getTime())) {
        setViewYear(hint.getFullYear())
        setViewMonth(hint.getMonth())
      }
    }
    setOpen(true)
    setMode('day')
  }

  useImperativeHandle(ref, () => ({ open: openPicker }), [])

  function buildDays() {
    const first    = new Date(viewYear, viewMonth, 1).getDay()
    const lastDay  = new Date(viewYear, viewMonth + 1, 0).getDate()
    const prevLast = new Date(viewYear, viewMonth, 0).getDate()
    const cells: { day: number; cur: boolean }[] = []

    for (let i = first - 1; i >= 0; i--)
      cells.push({ day: prevLast - i, cur: false })
    for (let d = 1; d <= lastDay; d++)
      cells.push({ day: d, cur: true })
    while (cells.length % 7 !== 0)
      cells.push({ day: cells.length - lastDay - first + 1, cur: false })

    return cells
  }

  function selectDay(day: number) {
    const iso = isoFromYMD(viewYear, viewMonth, day)
    if (!inRange(iso)) return  // belt + braces: disabled cells already block onClick
    onChange(iso)
    setOpen(false)
  }

  function isSelected(day: number) {
    if (!parsed) return false
    return parsed.getFullYear() === viewYear &&
           parsed.getMonth()    === viewMonth &&
           parsed.getDate()     === day
  }
  function isToday(day: number) {
    return today.getFullYear() === viewYear &&
           today.getMonth()    === viewMonth &&
           today.getDate()     === day
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0) }
    else setViewMonth(m => m + 1)
  }

  const yearList = Array.from({ length: 12 }, (_, i) => today.getFullYear() - 1 + i)

  const displayText = parsed
    ? `${parsed.getFullYear()}年 ${parsed.getMonth()+1}月 ${parsed.getDate()}日`
    : ''

  const triggerBorder = error ? 'border-danger' : open ? 'border-accent' : 'border-border'

  return (
    <div className="relative min-w-0">

      {/* ── Trigger ────────────────────────────────────────────── */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => openPicker()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker() } }}
        className={[
          'w-full min-h-12 rounded-input bg-app px-3 py-2.5 gap-2',
          'flex items-center cursor-pointer',
          'border-[1.5px] transition-colors',
          triggerBorder,
        ].join(' ')}
      >
        <span className="text-[15px] leading-6 shrink-0">📅</span>
        <span
          className={[
            'flex-1 text-left text-[14px] leading-6 min-w-0 truncate',
            displayText ? 'text-ink tracking-[0.02em]' : 'text-muted tracking-[0.04em]',
          ].join(' ')}
        >
          {displayText || placeholder}
        </span>
        {displayText && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onChange('') }}
            className="text-muted flex items-center cursor-pointer p-0.5 shrink-0 bg-transparent border-none"
            aria-label="日付をクリア"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      {/* ── Centered Dialog ───────────────────────────────────── */}
      <PickerDialog isOpen={open} onClose={() => setOpen(false)} title="日付を選択">

        {/* Header row */}
        <div className="flex items-center px-3.5 pt-3 pb-2 gap-1">
          <button onClick={prevMonth} className="w-7 h-7 rounded-lg bg-app text-muted flex items-center justify-center shrink-0 hover:bg-border transition-colors" aria-label="前の月">
            <ChevronLeft size={15} strokeWidth={2} />
          </button>

          <div className="flex-1 flex justify-center gap-1">
            <button
              onClick={() => setMode(m => m === 'year' ? 'day' : 'year')}
              className={[
                'px-2.5 py-1 rounded-lg text-[14px] font-bold tracking-[0.02em] transition-colors',
                mode === 'year' ? 'bg-accent text-white' : 'text-ink hover:bg-app',
              ].join(' ')}
            >
              {viewYear}年
            </button>
            <button
              onClick={() => setMode(m => m === 'month' ? 'day' : 'month')}
              className={[
                'px-2.5 py-1 rounded-lg text-[14px] font-bold tracking-[0.02em] transition-colors',
                mode === 'month' ? 'bg-accent text-white' : 'text-ink hover:bg-app',
              ].join(' ')}
            >
              {MONTHS[viewMonth]}
            </button>
          </div>

          <button onClick={nextMonth} className="w-7 h-7 rounded-lg bg-app text-muted flex items-center justify-center shrink-0 hover:bg-border transition-colors" aria-label="次の月">
            <ChevronRight size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Year picker */}
        {mode === 'year' && (
          <div className="px-3 pb-3 pt-1 grid grid-cols-4 gap-1.5">
            {yearList.map(y => (
              <button
                key={y}
                onClick={() => { setViewYear(y); setMode('day') }}
                className={[
                  'py-2 rounded-input text-[13px] cursor-pointer transition-colors',
                  y === viewYear
                    ? 'bg-accent text-white font-bold'
                    : y === today.getFullYear()
                      ? 'hover:bg-app font-normal'
                      : 'text-ink hover:bg-app font-normal',
                ].join(' ')}
                style={y !== viewYear && y === today.getFullYear() ? { color: PICKER_COLORS.today } : undefined}
              >
                {y}
              </button>
            ))}
          </div>
        )}

        {/* Month picker */}
        {mode === 'month' && (
          <div className="px-3 pb-3 pt-1 grid grid-cols-4 gap-1.5">
            {MONTHS.map((m, i) => {
              const isCurrentMonth = i === today.getMonth() && viewYear === today.getFullYear()
              return (
                <button
                  key={m}
                  onClick={() => { setViewMonth(i); setMode('day') }}
                  className={[
                    'py-2.5 rounded-input text-[13px] cursor-pointer transition-colors',
                    i === viewMonth
                      ? 'bg-accent text-white font-bold'
                      : 'text-ink hover:bg-app font-normal',
                  ].join(' ')}
                  style={i !== viewMonth && isCurrentMonth ? { color: PICKER_COLORS.today } : undefined}
                >
                  {m}
                </button>
              )
            })}
          </div>
        )}

        {/* Day grid */}
        {mode === 'day' && (
          <div className="px-2.5 pb-3">
            <div className="grid grid-cols-7 mb-1">
              {WEEKDAYS.map((w, i) => (
                <div
                  key={w}
                  className="text-center text-[10px] font-semibold py-1 tracking-[0.06em]"
                  style={{ color: i === 0 ? PICKER_COLORS.sunday : i === 6 ? PICKER_COLORS.saturday : 'var(--color-muted)' }}
                >
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {buildDays().map((cell, idx) => {
                const col       = idx % 7
                const selected  = cell.cur && isSelected(cell.day)
                const todayCell = cell.cur && isToday(cell.day)
                const isSun     = col === 0
                const isSat     = col === 6
                // Out-of-bounds (trip-range) days render the same way as
                // other-month grey cells — they're "exists but not for
                // you" rather than "doesn't exist", so the visual signal
                // is the same.
                const outOfRange = cell.cur && !inRange(isoFromYMD(viewYear, viewMonth, cell.day))
                const clickable  = cell.cur && !outOfRange

                const bg = selected ? 'var(--color-accent)' : todayCell && !outOfRange ? PICKER_COLORS.todayBg : 'transparent'
                const color = selected ? 'white'
                  : (!cell.cur || outOfRange) ? PICKER_COLORS.disabled
                  : todayCell ? PICKER_COLORS.today
                  : isSun ? PICKER_COLORS.sunday
                  : isSat ? PICKER_COLORS.saturday
                  : 'var(--color-ink)'
                const border = todayCell && !selected && !outOfRange ? `1.5px solid ${PICKER_COLORS.today}` : 'none'

                return (
                  <button
                    key={idx}
                    onClick={() => clickable && selectDay(cell.day)}
                    disabled={!clickable}
                    className={[
                      'aspect-square rounded-lg text-[13px] flex items-center justify-center transition-colors',
                      clickable ? 'cursor-pointer hover:brightness-95' : 'cursor-default',
                      selected || (todayCell && !outOfRange) ? 'font-bold' : 'font-normal',
                    ].join(' ')}
                    style={{ background: bg, color, border }}
                  >
                    {cell.day}
                  </button>
                )
              })}
            </div>

            <div className="mt-2.5 flex justify-center">
              {(() => {
                const todayIso = isoFromYMD(today.getFullYear(), today.getMonth(), today.getDate())
                const todayInRange = inRange(todayIso)
                return (
                  <button
                    disabled={!todayInRange}
                    onClick={() => {
                      if (!todayInRange) return
                      setViewYear(today.getFullYear())
                      setViewMonth(today.getMonth())
                      onChange(todayIso)
                      setOpen(false)
                    }}
                    className={[
                      'px-4 py-[5px] rounded-card border border-border bg-transparent text-[11px] tracking-[0.06em] font-medium transition-colors',
                      todayInRange
                        ? 'text-muted cursor-pointer hover:bg-app'
                        : 'text-border cursor-not-allowed',
                    ].join(' ')}
                  >
                    今日
                  </button>
                )
              })()}
            </div>
          </div>
        )}
      </PickerDialog>
    </div>
  )
})

export default DatePicker
