import type { ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const { requestRouteAutocomplete, requestRoutePlaceResolution } = vi.hoisted(() => ({
  requestRouteAutocomplete: vi.fn(),
  requestRoutePlaceResolution: vi.fn(),
}))

vi.mock('../services/routeOptimizationService', async importOriginal => ({
  ...await importOriginal<typeof import('../services/routeOptimizationService')>(),
  requestRouteAutocomplete,
  requestRoutePlaceResolution,
}))
vi.mock('@/hooks/useTripCurrency', () => ({ useTripCurrency: () => 'JPY' }))
vi.mock('@/hooks/useAutoFocus', () => ({ useAutoFocus: () => undefined }))
vi.mock('@/components/ui/FormModalShell', () => ({
  default: ({ children, onSave, saveLabel }: { children: ReactNode; onSave: () => void; saveLabel: string }) => (
    <div>
      {children}
      <button type="button" onClick={onSave}>{saveLabel}</button>
    </div>
  ),
}))
vi.mock('@/components/ui/pickers', () => ({
  DatePicker: () => <div data-testid="date-picker" />,
  TimePicker: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <input aria-label="開始時間" value={value} onChange={event => onChange(event.target.value)} />
  ),
}))
vi.mock('@/components/ui/CategoryChipRow', () => ({ default: () => <div /> }))
vi.mock('@/components/ui/CurrencyInput', () => ({ default: () => <input aria-label="預算" /> }))
vi.mock('@/components/ui/DeleteConfirm', () => ({ default: () => null }))

import ScheduleFormModal from './ScheduleFormModal'

function renderCreateForm(onSave = vi.fn()) {
  render(
    <ScheduleFormModal
      tripId="trip-1"
      editTarget={null}
      defaultDate="2026-07-20"
      schedules={[]}
      defaultCountryCode="JP"
      isOpen
      isSaving={false}
      onClose={() => undefined}
      onSave={onSave}
    />,
  )
  return onSave
}

describe('ScheduleFormModal duration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestRouteAutocomplete.mockResolvedValue([])
    requestRoutePlaceResolution.mockResolvedValue([])
  })

  test('lets a flexible schedule persist an explicit duration without a start time', () => {
    const onSave = renderCreateForm()
    fireEvent.change(screen.getByPlaceholderText('例如：參觀淺草雷門'), { target: { value: '自由散步' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '預計停留時間（分鐘）' }), {
      target: { value: '90' },
    })
    fireEvent.click(screen.getByRole('button', { name: '新增行程' }))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      startTime: undefined,
      timeMode: 'flexible',
      durationMinutes: 90,
    }))
  })

  test('shows a read-only derived end time for a timed schedule', () => {
    renderCreateForm()
    fireEvent.change(screen.getByRole('textbox', { name: '開始時間' }), { target: { value: '10:00' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '預計停留時間（分鐘）' }), {
      target: { value: '90' },
    })

    expect(screen.getByText('預計結束 11:30')).toBeTruthy()
    expect(screen.queryByText('結束時間')).toBeNull()
  })

  test('blocks a timed schedule that would cross midnight', () => {
    const onSave = renderCreateForm()
    fireEvent.change(screen.getByPlaceholderText('例如：參觀淺草雷門'), { target: { value: '深夜行程' } })
    fireEvent.change(screen.getByRole('textbox', { name: '開始時間' }), { target: { value: '23:30' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '預計停留時間（分鐘）' }), {
      target: { value: '60' },
    })
    fireEvent.click(screen.getByRole('button', { name: '新增行程' }))

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText('行程不得跨越午夜')).toBeTruthy()
  })
})

describe('ScheduleFormModal location autocomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestRouteAutocomplete.mockRejectedValue(new Error('provider unavailable'))
    requestRoutePlaceResolution.mockRejectedValue(new Error('provider unavailable'))
  })

  test('announces an inline Traditional Chinese error when autocomplete fails', async () => {
    vi.useFakeTimers()
    try {
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      )

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '東京鐵塔' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })

      expect(screen.getByRole('status').textContent).toContain('無法搜尋地點，請稍後再試')
    } finally {
      vi.useRealTimers()
    }
  })

  test('shows progress promptly while autocomplete is still pending', async () => {
    vi.useFakeTimers()
    try {
      let resolveRequest!: (value: []) => void
      requestRouteAutocomplete.mockReturnValue(new Promise(resolve => { resolveRequest = resolve }))
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      )

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '東京鐵塔' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(149) })
      expect(requestRouteAutocomplete).not.toHaveBeenCalled()

      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(screen.getByText('搜尋地點中…')).toBeTruthy()
      expect(screen.queryByRole('status')).toBeNull()

      await act(async () => { resolveRequest([]); await Promise.resolve() })
    } finally {
      vi.useRealTimers()
    }
  })

  test('announces when autocomplete returns no candidates', async () => {
    vi.useFakeTimers()
    try {
      requestRouteAutocomplete.mockResolvedValue([])
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      )

      fireEvent.change(screen.getByRole('combobox'), { target: { value: '不存在地點' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })

      expect(screen.getByRole('status').textContent)
        .toContain('找不到符合的地點，請嘗試加入城市或完整名稱')
    } finally {
      vi.useRealTimers()
    }
  })

  test('routes a Google Maps URL through the secure place resolver instead of autocomplete', async () => {
    vi.useFakeTimers()
    try {
      requestRoutePlaceResolution.mockResolvedValue([{
        provider: 'geoapify',
        providerPlaceId: 'enoshima',
        name: '江ノ島',
        address: '藤澤市, 日本',
        lat: 35.299,
        lng: 139.481,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      }])
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      )

      const mapsUrl = 'https://maps.app.goo.gl/Enoshima123'
      fireEvent.change(screen.getByRole('combobox'), { target: { value: mapsUrl } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })

      expect(requestRoutePlaceResolution).toHaveBeenCalledWith(
        'trip-1',
        mapsUrl,
        expect.any(AbortSignal),
        { biasCountryCode: 'JP', normalizationCountryCode: 'JP' },
      )
      expect(requestRouteAutocomplete).not.toHaveBeenCalled()
      expect(screen.getByRole('option').textContent).toContain('江ノ島')
    } finally {
      vi.useRealTimers()
    }
  })

  test('announces when a Google Maps URL has no semantically matching Geoapify candidate', async () => {
    vi.useFakeTimers()
    try {
      requestRoutePlaceResolution.mockResolvedValue([])
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      )

      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'https://maps.app.goo.gl/77eHSXgc8AQgjkbA9' },
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })

      const input = screen.getByRole('combobox')
      const status = screen.getByRole('status')
      expect(status.textContent)
        .toContain('找不到與 Google 地點相符的結果')
      expect(input.parentElement?.contains(status)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not spend provider quota for a non-Google URL', async () => {
    vi.useFakeTimers()
    try {
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={() => undefined}
        />,
      )

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'https://example.com/place' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })

      expect(requestRoutePlaceResolution).not.toHaveBeenCalled()
      expect(requestRouteAutocomplete).not.toHaveBeenCalled()
      expect(screen.getByRole('status').textContent).toContain('僅支援 Google Maps 連結')
    } finally {
      vi.useRealTimers()
    }
  })

  test('blocks saving a Google Maps URL until resolution finishes', () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn()
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={onSave}
        />,
      )

      fireEvent.change(screen.getByPlaceholderText('例如：參觀淺草雷門'), { target: { value: '江之島' } })
      fireEvent.change(screen.getByRole('combobox'), {
        target: { value: 'https://maps.app.goo.gl/77eHSXgc8AQgjkbA9' },
      })
      fireEvent.click(screen.getByRole('button', { name: '新增行程' }))

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByText('請等待 Google Maps 連結解析完成並選擇地點')).toBeTruthy()
      expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBe('true')
    } finally {
      vi.useRealTimers()
    }
  })

  test('blocks saving an unsupported HTTP URL without waiting for debounce', () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn()
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={onSave}
        />,
      )

      fireEvent.change(screen.getByPlaceholderText('例如：參觀淺草雷門'), { target: { value: '測試行程' } })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'https://example.com/place' } })
      fireEvent.click(screen.getByRole('button', { name: '新增行程' }))

      expect(onSave).not.toHaveBeenCalled()
      expect(screen.getByText('僅支援 Google Maps 連結')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('allows saving after selecting a resolved candidate', async () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn()
      requestRouteAutocomplete.mockResolvedValue([{
        provider: 'geoapify',
        providerPlaceId: 'hase-station',
        name: '長谷駅',
        address: '鎌倉市, 日本',
        lat: 35.311,
        lng: 139.536,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      }])
      render(
        <ScheduleFormModal
          tripId="trip-1"
          editTarget={null}
          defaultDate="2026-07-20"
          schedules={[]}
          defaultCountryCode="JP"
          isOpen
          isSaving={false}
          onClose={() => undefined}
          onSave={onSave}
        />,
      )

      fireEvent.change(screen.getByPlaceholderText('例如：參觀淺草雷門'), { target: { value: '長谷站' } })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '長谷站' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(150) })
      fireEvent.click(screen.getByRole('option', { name: /長谷駅/ }))
      fireEvent.click(screen.getByRole('button', { name: '新增行程' }))

      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        location: expect.objectContaining({
          status: 'resolved',
          place: expect.objectContaining({ providerPlaceId: 'hase-station' }),
        }),
      }))
    } finally {
      vi.useRealTimers()
    }
  })
})
