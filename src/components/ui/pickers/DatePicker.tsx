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
  { value, onChange, placeholder = '日付を選択', error = false },
  ref,
) {
  const today  = new Date()
  const parsed = value ? fromLocalDateString(value) : null

  const [open,      setOpen]      = useState(false)
  const [viewYear,  setViewYear]  = useState(() => parsed ? parsed.getFullYear() : today.getFullYear())
  const [viewMonth, setViewMonth] = useState(() => parsed ? parsed.getMonth()    : today.getMonth())
  const [mode,      setMode]      = useState<'day' | 'month' | 'year'>('day')

  // Sync view to external value changes — intentionally only re-runs on `value`.
  useEffect(() => {
    if (!parsed) return
    setViewYear(parsed.getFullYear())
    setViewMonth(parsed.getMonth())
     // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const mm = String(viewMonth + 1).padStart(2, '0')
    const dd = String(day).padStart(2, '0')
    onChange(`${viewYear}-${mm}-${dd}`)
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
          'w-full h-[42px] rounded-input bg-app px-3 gap-2',
          'flex items-center cursor-pointer',
          'border-[1.5px] transition-colors',
          triggerBorder,
        ].join(' ')}
      >
        <span className="text-[15px] leading-none shrink-0">📅</span>
        <span
          className={[
            'flex-1 text-left text-[14px] min-w-0 truncate',
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

                const bg = selected ? 'var(--color-accent)' : todayCell ? PICKER_COLORS.todayBg : 'transparent'
                const color = selected ? 'white'
                  : !cell.cur ? PICKER_COLORS.disabled
                  : todayCell ? PICKER_COLORS.today
                  : isSun ? PICKER_COLORS.sunday
                  : isSat ? PICKER_COLORS.saturday
                  : 'var(--color-ink)'
                const border = todayCell && !selected ? `1.5px solid ${PICKER_COLORS.today}` : 'none'

                return (
                  <button
                    key={idx}
                    onClick={() => cell.cur && selectDay(cell.day)}
                    disabled={!cell.cur}
                    className={[
                      'aspect-square rounded-lg text-[13px] flex items-center justify-center transition-colors',
                      cell.cur ? 'cursor-pointer hover:brightness-95' : 'cursor-default',
                      selected || todayCell ? 'font-bold' : 'font-normal',
                    ].join(' ')}
                    style={{ background: bg, color, border }}
                  >
                    {cell.day}
                  </button>
                )
              })}
            </div>

            <div className="mt-2.5 flex justify-center">
              <button
                onClick={() => {
                  const y = today.getFullYear()
                  const m = today.getMonth()
                  const d = today.getDate()
                  setViewYear(y)
                  setViewMonth(m)
                  const mm = String(m + 1).padStart(2, '0')
                  const dd = String(d).padStart(2, '0')
                  onChange(`${y}-${mm}-${dd}`)
                  setOpen(false)
                }}
                className="px-4 py-[5px] rounded-card border border-border bg-transparent text-muted text-[11px] cursor-pointer tracking-[0.06em] font-medium hover:bg-app transition-colors"
              >
                今日
              </button>
            </div>
          </div>
        )}
      </PickerDialog>
    </div>
  )
})

export default DatePicker
