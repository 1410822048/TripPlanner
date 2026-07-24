// src/features/schedule/components/ScheduleFormModal.tsx
// The caller (SchedulePage) re-keys this component by `editTarget?.id ?? 'new'`
// so every switch to a different schedule (or to "create new") produces a
// fresh mount. That lets all form state initialize directly from props via
// useState initializers — no sync-in-effect, no mid-typing state wipes.
import { useEffect, useRef, useState } from 'react'
import { Lock, MapPin, Unlock } from 'lucide-react'
import type { Schedule, ScheduleCategory, CreateScheduleInput, ScheduleLocation } from '@/types'
import { scheduleLocationName } from '@/types/schedule'
import {
  effectiveEndTime,
  ScheduleTimingError,
  shouldRequestLocationAutocomplete,
  validateScheduleTiming,
} from '../routeModel'
import {
  requestRouteAutocomplete,
  requestRoutePlaceResolution,
  type PlaceCandidate,
} from '../services/routeOptimizationService'
import FormModalShell from '@/components/ui/FormModalShell'
import { DatePicker, TimePicker } from '@/components/ui/pickers'
import FormField from '@/components/ui/FormField'
import { inputClass } from '@/components/ui/inputStyle'
import CurrencyInput from '@/components/ui/CurrencyInput'
import DeleteConfirm from '@/components/ui/DeleteConfirm'
import CategoryChipRow from '@/components/ui/CategoryChipRow'
import { useTripCurrency } from '@/hooks/useTripCurrency'
import { currencySymbol } from '@/utils/currency'
import { formatMinorForInput, parseMoneyToMinor, MoneyParseError } from '@/utils/money'
import { CATEGORY_ICON, SCHEDULE_CATEGORIES } from '@/shared/categoryMeta'
import { useAutoFocus } from '@/hooks/useAutoFocus'
import { useFormReducer } from '@/hooks/useFormReducer'
import { isGoogleMapsUrl } from '@/utils/maps'
import { deriveScheduleSearchContext } from '@/features/trips/countryContext'

// `type` (not `interface`) so TS treats it as closed and the shape
// satisfies useFormReducer's `Record<string, unknown>` constraint.
type FormState = {
  title:     string
  date:      string
  startTime: string
  durationMinutes: string
  category:  ScheduleCategory
  location:  string
  locationRef?: ScheduleLocation
  locked:    boolean
  desc:      string
  costText:  string                // raw user-typed money string; parsed to minor units on save
}

const DEFAULT_SCHEDULE_CATEGORY: ScheduleCategory = SCHEDULE_CATEGORIES[0]?.value ?? 'transport'

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function initFormState(t: Schedule | null, defaultDate: string, currency: string): FormState {
  return {
    title:     t?.title ?? '',
    date:      t?.date ?? defaultDate,
    startTime: t?.startTime ?? '',
    durationMinutes: String(t?.durationMinutes ?? 60),
    category:  t?.category ?? DEFAULT_SCHEDULE_CATEGORY,
    location:  scheduleLocationName(t?.location) ?? '',
    locationRef: t?.location,
    locked: t?.timeMode === 'fixed',
    desc:      t?.description ?? '',
    costText:  typeof t?.estimatedCostMinor === 'number'
      ? formatMinorForInput(t.estimatedCostMinor, currency)
      : '',
  }
}

function parseDurationMinutes(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const text = value.trim()
  if (!/^\d+$/.test(text)) return { ok: false, error: '請輸入停留分鐘數' }
  const minutes = Number(text)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) {
    return { ok: false, error: '請輸入 1 到 720 分鐘' }
  }
  return { ok: true, value: minutes }
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) return `${remainder} 分鐘`
  if (remainder === 0) return `${hours} 小時`
  return `${hours} 小時 ${remainder} 分鐘`
}

interface Props {
  tripId:      string
  editTarget:  Schedule | null
  defaultDate: string
  /** Inclusive trip date range — schedule must fall inside this window.
   *  Forwarded to DatePicker so out-of-range days are disabled in the
   *  calendar UI rather than rejected after submission. */
  tripStartDate?: string
  tripEndDate?:   string
  schedules:    Schedule[]
  defaultCountryCode: string
  isOpen:      boolean
  isSaving:    boolean
  saveError?:  string | null
  onClose:     () => void
  onSave:      (data: CreateScheduleInput) => void
  onDelete?:   () => void
}

export default function ScheduleFormModal({
  tripId, editTarget, defaultDate, tripStartDate, tripEndDate,
  schedules, defaultCountryCode,
  isOpen, isSaving, saveError, onClose, onSave, onDelete,
}: Props) {
  const currency = useTripCurrency()
  const symbol   = currencySymbol(currency)
  const { state, setField } = useFormReducer<FormState>(
    () => initFormState(editTarget, defaultDate, currency),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [suggestions, setSuggestions] = useState<PlaceCandidate[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [isLocationSearching, setIsLocationSearching] = useState(false)
  const [autocompleteError, setAutocompleteError] = useState<string | null>(null)
  const autocompleteActive = shouldRequestLocationAutocomplete({
    isOpen,
    query: state.location,
    location: state.locationRef,
  })
  const visibleSuggestions = autocompleteActive ? suggestions : []
  const parsedDuration = parseDurationMinutes(state.durationMinutes)
  const derivedEndTime = parsedDuration.ok
    ? effectiveEndTime({ startTime: state.startTime, durationMinutes: parsedDuration.value })
    : undefined
  const { biasCountryCode, normalizationCountryCode } = deriveScheduleSearchContext({
    date: state.date,
    schedules,
    defaultCountryCode,
    excludeScheduleId: editTarget?.id,
  })

  const titleRef = useRef<HTMLInputElement>(null)
  useAutoFocus(titleRef, isOpen)

  useEffect(() => {
    const query = state.location.trim()
    if (!shouldRequestLocationAutocomplete({ isOpen, query, location: state.locationRef })) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (isHttpUrl(query) && !isGoogleMapsUrl(query)) {
        setIsLocationSearching(false)
        setSuggestions([])
        setActiveSuggestion(-1)
        setAutocompleteError('僅支援 Google Maps 連結')
        return
      }
      const isGoogleMapsQuery = isGoogleMapsUrl(query)
      setIsLocationSearching(true)
      setAutocompleteError(null)
      const request = isGoogleMapsQuery
        ? requestRoutePlaceResolution(tripId, query, controller.signal, { biasCountryCode, normalizationCountryCode })
        : requestRouteAutocomplete(tripId, query, controller.signal, { biasCountryCode, normalizationCountryCode })
      request
        .then(results => {
          if (!controller.signal.aborted) {
            setIsLocationSearching(false)
            setSuggestions(results)
            setActiveSuggestion(-1)
            setAutocompleteError(
              results.length === 0
                ? isGoogleMapsQuery
                  ? '找不到與 Google 地點相符的結果'
                  : '找不到符合的地點，請嘗試加入城市或完整名稱'
                : null,
            )
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setIsLocationSearching(false)
            setSuggestions([])
            setAutocompleteError('無法搜尋地點，請稍後再試')
          }
        })
    }, 150)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [
    isOpen,
    state.location,
    state.locationRef,
    state.date,
    tripId,
    biasCountryCode,
    normalizationCountryCode,
  ])

  function selectSuggestion(candidate: PlaceCandidate) {
    setField('location', candidate.name)
    setField('locationRef', { status: 'resolved', place: candidate })
    setIsLocationSearching(false)
    setSuggestions([])
    setActiveSuggestion(-1)
    setAutocompleteError(null)
    clearError('location')
  }

  // Drop a single key from the errors map as soon as the user edits the
  // corresponding field, without waiting for the next save attempt.
  function clearError(key: string) {
    setErrors(prev => {
      if (!(key in prev)) return prev
      const next: Record<string, string> = {}
      for (const k of Object.keys(prev)) if (k !== key) next[k] = prev[k]!
      return next
    })
  }

  function parseCostMinor(): { ok: true; value: number | undefined } | { ok: false; error: string } {
    const text = state.costText.trim()
    if (text === '') return { ok: true, value: undefined }
    try {
      const minor = parseMoneyToMinor(text, currency)
      if (minor < 0) return { ok: false, error: '請輸入大於或等於 0 的金額' }
      return { ok: true, value: minor }
    } catch (e) {
      if (e instanceof MoneyParseError) return { ok: false, error: '請輸入數字' }
      throw e
    }
  }

  function validate() {
    const e: Record<string, string> = {}
    if (!state.title.trim()) e.title = '請輸入標題'
    if (!state.date)         e.date  = '請選擇日期'
    const locationQuery = state.location.trim()
    if (isHttpUrl(locationQuery) && state.locationRef?.status !== 'resolved') {
      e.location = isGoogleMapsUrl(locationQuery)
        ? '請等待 Google Maps 連結解析完成並選擇地點'
        : '僅支援 Google Maps 連結'
    }
    const parsed = parseCostMinor()
    if (!parsed.ok) e.cost = parsed.error
    const duration = parseDurationMinutes(state.durationMinutes)
    if (!duration.ok) {
      e.durationMinutes = duration.error
    } else {
      try {
        validateScheduleTiming({
          startTime: state.startTime || undefined,
          durationMinutes: duration.value,
          timeMode: state.locked ? 'fixed' : (state.startTime ? 'preferred' : 'flexible'),
        })
      } catch (error) {
        if (!(error instanceof ScheduleTimingError)) throw error
        switch (error.code) {
          case 'CROSSES_MIDNIGHT':
            e.durationMinutes = '行程不得跨越午夜'
            break
          case 'DURATION_INVALID':
            e.durationMinutes = '停留時間須介於 1–720 分鐘'
            break
          case 'INVALID_TIME':
          case 'START_TIME_REQUIRED':
            e.startTime = '請設定有效的開始時間'
            break
        }
      }
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSave() {
    if (!validate()) return
    const parsed = parseCostMinor()
    if (!parsed.ok) return  // re-checked here for type narrowing; validate() already surfaced
    const duration = parseDurationMinutes(state.durationMinutes)
    if (!duration.ok) return
    const loc = state.location.trim()
    const timing = validateScheduleTiming({
      startTime: state.startTime || undefined,
      durationMinutes: duration.value,
      timeMode: state.locked ? 'fixed' : (state.startTime ? 'preferred' : 'flexible'),
    })
    onSave({
      title: state.title.trim(),
      date:  state.date,
      startTime:          timing.startTime,
      timeMode:           timing.timeMode,
      durationMinutes:    timing.durationMinutes,
      category:           state.category,
      description:        state.desc      || undefined,
      estimatedCostMinor: parsed.value,
      location:           state.locationRef ?? (loc ? { status: 'unresolved', query: loc } : undefined),
    } satisfies CreateScheduleInput)
  }

  return (
    <FormModalShell
      isOpen={isOpen}
      isSaving={isSaving}
      title={editTarget ? '編輯行程' : '新增行程'}
      saveLabel={editTarget ? '儲存變更' : '新增行程'}
      saveError={saveError}
      onClose={onClose}
      onSave={handleSave}
    >
      <FormField label="標題" error={errors.title} required>
        <input
          ref={titleRef}
          value={state.title}
          onChange={e => setField('title', e.target.value)}
          placeholder="例如：參觀淺草雷門"
          className={inputClass(!!errors.title)}
        />
      </FormField>

      <FormField label="分類">
        <CategoryChipRow
          categories={SCHEDULE_CATEGORIES}
          icons={CATEGORY_ICON}
          active={state.category}
          onSelect={v => setField('category', v)}
        />
      </FormField>

      <FormField label="日期" error={errors.date} required>
        <DatePicker
          value={state.date}
          onChange={v => setField('date', v)}
          error={!!errors.date}
          minDate={tripStartDate}
          maxDate={tripEndDate}
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2.5 items-start">
        <FormField label="開始時間" error={errors.startTime}>
          <TimePicker
            value={state.startTime}
            ariaLabel="開始時間"
            error={!!errors.startTime}
            onChange={v => {
              setField('startTime', v)
              if (!v && state.locked) setField('locked', false)
              clearError('startTime')
              clearError('durationMinutes')
            }}
          />
        </FormField>
        <FormField label="預計停留時間" error={errors.durationMinutes} required>
          <div className={[
            'flex min-h-12 min-w-0 items-center rounded-input bg-app px-3 py-2.5',
            'border-[1.5px] transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
            errors.durationMinutes ? 'border-danger' : 'border-border',
          ].join(' ')}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={720}
              step={5}
              value={state.durationMinutes}
              aria-label="預計停留時間（分鐘）"
              aria-invalid={errors.durationMinutes ? true : undefined}
              aria-describedby="schedule-duration-hint"
              onChange={event => {
                setField('durationMinutes', event.target.value)
                clearError('durationMinutes')
              }}
              className="min-w-0 flex-1 bg-transparent text-[16px] leading-6 text-ink outline-none tabular-nums"
            />
            <span className="shrink-0 pl-1.5 text-[12px] text-muted">分鐘</span>
          </div>
          <span id="schedule-duration-hint" className="text-[11px] text-muted">
            {parsedDuration.ok ? formatDuration(parsedDuration.value) : '1 到 720 分鐘'}
          </span>
        </FormField>
      </div>

      {state.startTime && parsedDuration.ok && derivedEndTime && (
        <p className="-mt-2 text-[11px] text-muted">
          預計結束 {derivedEndTime}
        </p>
      )}

      <FormField label="時間約束">
        <button
          type="button"
          aria-pressed={state.locked}
          disabled={!state.startTime}
          onClick={() => setField('locked', !state.locked)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[12px] font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-55"
        >
          {state.locked ? <Lock size={13} /> : <Unlock size={13} />}
          {!state.startTime ? '彈性時間' : state.locked ? '固定時間' : '偏好時間'}
        </button>
      </FormField>

      <FormField label="地點">
        <div className="relative">
          <div className="relative">
            <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-muted" />
            <input
              value={state.location}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={visibleSuggestions.length > 0}
              aria-controls="schedule-location-options"
              aria-invalid={errors.location ? true : undefined}
              aria-describedby={errors.location
                ? 'schedule-location-validation-error'
                : isLocationSearching
                  ? 'schedule-location-loading'
                  : autocompleteError ? 'schedule-location-error' : undefined}
              aria-activedescendant={activeSuggestion >= 0 && activeSuggestion < visibleSuggestions.length ? `schedule-location-option-${activeSuggestion}` : undefined}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' && visibleSuggestions.length > 0) {
                  e.preventDefault()
                  setActiveSuggestion(index => Math.min(index + 1, visibleSuggestions.length - 1))
                } else if (e.key === 'ArrowUp' && visibleSuggestions.length > 0) {
                  e.preventDefault()
                  setActiveSuggestion(index => Math.max(index - 1, -1))
                } else if (e.key === 'Enter' && activeSuggestion >= 0) {
                  e.preventDefault()
                  const candidate = visibleSuggestions[activeSuggestion]
                  if (candidate) selectSuggestion(candidate)
                } else if (e.key === 'Escape') {
                  setSuggestions([])
                }
              }}
              onChange={e => {
                setField('location', e.target.value)
                setField('locationRef', undefined)
                setSuggestions([])
                setActiveSuggestion(-1)
                setIsLocationSearching(false)
                setAutocompleteError(null)
                clearError('location')
              }}
              placeholder="例：淺草寺"
              className={`${inputClass(!!errors.location)} pl-[34px]`}
            />
            {visibleSuggestions.length > 0 && (
              <div id="schedule-location-options" role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-[14px] border border-border bg-surface p-1 shadow-lg">
                {visibleSuggestions.map((candidate, index) => (
                  <button
                    key={candidate.providerPlaceId}
                    id={`schedule-location-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestion}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => selectSuggestion(candidate)}
                    className="block w-full rounded-[10px] px-3 py-2 text-left text-[12px] text-ink hover:bg-app"
                  >
                    <span className="block font-semibold">{candidate.name}</span>
                    {candidate.address && <span className="block truncate text-[10px] text-muted">{candidate.address}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {errors.location && (
            <p id="schedule-location-validation-error" role="alert" className="mt-1.5 text-[11px] text-danger">
              {errors.location}
            </p>
          )}
          {!errors.location && isLocationSearching && (
            <p id="schedule-location-loading" className="mt-1.5 text-[11px] text-muted">
              搜尋地點中…
            </p>
          )}
          {!errors.location && !isLocationSearching && autocompleteError && (
            <p id="schedule-location-error" role="status" className="mt-1.5 text-[11px] text-danger">
              {autocompleteError}
            </p>
          )}
        </div>
      </FormField>

      <FormField label={`預算（${symbol}）`} error={errors.cost}>
        <CurrencyInput
          symbol={symbol}
          value={state.costText}
          onChange={e => setField('costText', e.target.value)}
          placeholder="0"
          error={!!errors.cost}
        />
      </FormField>

      <FormField label="備註">
        <textarea
          value={state.desc}
          onChange={e => setField('desc', e.target.value)}
          placeholder="備註或注意事項"
          rows={3}
          className={`${inputClass(false)} resize-none leading-[1.6] py-2.5 h-auto`}
        />
      </FormField>

      {editTarget && onDelete && <DeleteConfirm noun="行程" onDelete={onDelete} />}
    </FormModalShell>
  )
}
