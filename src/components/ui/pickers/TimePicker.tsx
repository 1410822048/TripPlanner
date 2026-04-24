// src/components/ui/pickers/TimePicker.tsx
import { useEffect, useRef, useState } from 'react'
import { Clock, X } from 'lucide-react'
import PickerDialog from './PickerDialog'
import { WHEEL_ITEM_HEIGHT, WHEEL_VISIBLE, WHEEL_PAD_ROWS } from './constants'

interface Props {
  value:       string        // 'HH:MM' or ''
  onChange:    (v: string) => void
  placeholder?: string
  error?:      boolean
  /** 分鐘間隔（預設 5）— 5 分鐘粒度足以涵蓋旅行行程 */
  minuteStep?: number
}

/** 把當前時間對齊到 step 粒度（用於 draft 初始值） */
function snapMinute(m: number, step: number): number {
  const s = Math.round(m / step) * step
  return s >= 60 ? 0 : s
}

export default function TimePicker({
  value, onChange, placeholder = '時間を選択', error = false, minuteStep = 5,
}: Props) {
  const [open, setOpen] = useState(false)

  const [hh, mm] = value ? value.split(':') : ['', '']

  const hours   = Array.from({ length: 24 }, (_, i) => i)
  const minutes = Array.from(
    { length: Math.ceil(60 / minuteStep) },
    (_, i) => i * minuteStep,
  )

  // Lazy initializer — only runs on mount
  const [draftH, setDraftH] = useState(() => {
    if (hh !== '') return Number(hh)
    return new Date().getHours()
  })
  const [draftM, setDraftM] = useState(() => {
    if (mm !== '') return Number(mm)
    return snapMinute(new Date().getMinutes(), minuteStep)
  })

  // Reset draft to the current value (or "now") whenever the picker re-opens.
  // Implemented as an effect on `open` because the draft state lives inside
  // this component and the parent only toggles open/close — a key-remount
  // would remount the dialog shell too and break the open/close transition.
  // rules-of-hooks flags setState-in-effect as a cascade-render smell; here
  // it's intentional (reset on edge trigger), the next render is the one we
  // want, so we opt out of the rule with an explicit comment.
  useEffect(() => {
    if (!open) return
    const now = new Date()
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraftH(hh !== '' ? Number(hh) : now.getHours())
    setDraftM(mm !== '' ? Number(mm) : snapMinute(now.getMinutes(), minuteStep))
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function commit() {
    const hStr = String(draftH).padStart(2, '0')
    const mStr = String(draftM).padStart(2, '0')
    onChange(`${hStr}:${mStr}`)
    setOpen(false)
  }

  const triggerBorder = error ? 'border-danger' : open ? 'border-accent' : 'border-border'

  return (
    <div className="relative min-w-0">

      {/* ── Trigger ────────────────────────────────────────────── */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true) } }}
        className={[
          'w-full h-[42px] rounded-input bg-app px-3 gap-2',
          'flex items-center cursor-pointer',
          'border-[1.5px] transition-colors',
          triggerBorder,
        ].join(' ')}
      >
        <Clock size={14} className="text-muted shrink-0" />
        <span
          className={[
            'flex-1 text-left text-[14px] min-w-0 truncate',
            value ? 'text-ink tracking-[0.02em]' : 'text-muted tracking-[0.04em]',
          ].join(' ')}
        >
          {value || placeholder}
        </span>
        {value && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onChange('') }}
            className="text-muted flex items-center cursor-pointer p-0.5 shrink-0 bg-transparent border-none"
            aria-label="時間をクリア"
          >
            <X size={13} strokeWidth={2} />
          </button>
        )}
      </div>

      {/* ── Wheel Dialog ──────────────────────────────────────── */}
      <PickerDialog isOpen={open} onClose={() => setOpen(false)} title="時間を選択">

        {/* Current draft display */}
        <div className="flex items-center justify-center pt-4 pb-2 gap-1.5">
          <span className="text-[22px] font-bold tabular-nums tracking-[0.02em] text-ink">
            {String(draftH).padStart(2, '0')}
          </span>
          <span className="text-[22px] font-bold text-muted">:</span>
          <span className="text-[22px] font-bold tabular-nums tracking-[0.02em] text-ink">
            {String(draftM).padStart(2, '0')}
          </span>
        </div>

        {/* Wheel columns */}
        <div className="relative mx-auto" style={{ width: 200, height: WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE }}>
          {/* Center band */}
          <div
            className="absolute inset-x-0 pointer-events-none z-10"
            style={{
              top: WHEEL_ITEM_HEIGHT * WHEEL_PAD_ROWS,
              height: WHEEL_ITEM_HEIGHT,
              borderTop: '1px solid var(--color-border)',
              borderBottom: '1px solid var(--color-border)',
              background: 'rgba(0,0,0,0.02)',
            }}
          />
          {/* Top & bottom fades */}
          <div
            className="absolute inset-x-0 top-0 pointer-events-none z-10"
            style={{
              height: WHEEL_ITEM_HEIGHT * WHEEL_PAD_ROWS,
              background: 'linear-gradient(to bottom, var(--color-surface), transparent)',
            }}
          />
          <div
            className="absolute inset-x-0 bottom-0 pointer-events-none z-10"
            style={{
              height: WHEEL_ITEM_HEIGHT * WHEEL_PAD_ROWS,
              background: 'linear-gradient(to top, var(--color-surface), transparent)',
            }}
          />

          <div className="flex h-full">
            <WheelColumn
              values={hours}
              selected={draftH}
              onSelect={setDraftH}
              format={v => String(v).padStart(2, '0')}
              label="時"
            />
            <div className="w-px bg-border self-stretch my-auto" style={{ height: WHEEL_ITEM_HEIGHT }} />
            <WheelColumn
              values={minutes}
              selected={draftM}
              onSelect={setDraftM}
              format={v => String(v).padStart(2, '0')}
              label="分"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-4 pt-3 pb-4">
          <button
            onClick={() => setOpen(false)}
            className="flex-1 py-2.5 rounded-input border border-border bg-transparent text-muted text-[13px] font-medium cursor-pointer tracking-[0.04em] hover:bg-app transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={commit}
            className="flex-1 py-2.5 rounded-input bg-accent text-white text-[13px] font-bold cursor-pointer tracking-[0.04em] hover:brightness-95 transition-[filter]"
          >
            決定
          </button>
        </div>
      </PickerDialog>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────
interface WheelProps<T extends number> {
  values:   T[]
  selected: T
  onSelect: (v: T) => void
  format:   (v: T) => string
  label:    string
}

function WheelColumn<T extends number>({ values, selected, onSelect, format, label }: WheelProps<T>) {
  const ref      = useRef<HTMLDivElement>(null)
  const timer    = useRef<number | undefined>(undefined)
  const syncing  = useRef(false)

  // 初始化 + 外部 selected 變動時同步 scrollTop
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const idx = values.indexOf(selected)
    if (idx < 0) return
    const target = idx * WHEEL_ITEM_HEIGHT
    if (Math.abs(el.scrollTop - target) > 1) {
      syncing.current = true
      el.scrollTop = target
      window.setTimeout(() => { syncing.current = false }, 60)
    }
  }, [selected, values])

  function handleScroll() {
    if (syncing.current) return
    const el = ref.current
    if (!el) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const idx = Math.round(el.scrollTop / WHEEL_ITEM_HEIGHT)
      const clamped = Math.max(0, Math.min(values.length - 1, idx))
      const v = values[clamped]
      if (v !== undefined && v !== selected) onSelect(v)
    }, 90)
  }

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      aria-label={label}
      className="flex-1 overflow-y-scroll overscroll-contain [&::-webkit-scrollbar]:hidden"
      style={{
        scrollSnapType: 'y mandatory',
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <div style={{ height: WHEEL_ITEM_HEIGHT * WHEEL_PAD_ROWS }} />
      {values.map(v => {
        const isSel = v === selected
        return (
          <div
            key={v}
            className="flex items-center justify-center tabular-nums select-none"
            style={{
              height: WHEEL_ITEM_HEIGHT,
              scrollSnapAlign: 'center',
              fontSize: isSel ? '20px' : '17px',
              fontWeight: isSel ? 700 : 400,
              color: isSel ? 'var(--color-ink)' : 'var(--color-muted)',
              opacity: isSel ? 1 : 0.55,
              transition: 'font-size 0.12s ease, opacity 0.12s ease',
            }}
          >
            {format(v)}
          </div>
        )
      })}
      <div style={{ height: WHEEL_ITEM_HEIGHT * WHEEL_PAD_ROWS }} />
    </div>
  )
}
