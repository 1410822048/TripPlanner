import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Schedule } from '@/types'
import type { RoutePreview } from '../services/routeOptimizationService'
import { WorkerRejected } from '@/services/workerBase'

const { applyRoutePreview, requestRoutePreview, routeErrorMessage } = vi.hoisted(() => ({
  applyRoutePreview: vi.fn(),
  requestRoutePreview: vi.fn(),
  routeErrorMessage: vi.fn<(reason: unknown, operation: 'preview' | 'apply') => string>(
    () => '路線服務暫時無法使用，請稍後再試',
  ),
}))

vi.mock('../services/routeOptimizationService', () => ({
  applyRoutePreview,
  requestRoutePreview,
  routeErrorMessage,
}))
vi.mock('@/components/ui/BottomSheet', () => ({
  default: ({ children, footer, title, onClose, dismissible = true }: {
    children: ReactNode
    footer: ReactNode
    title: string
    onClose: () => void
    dismissible?: boolean
  }) => (
    <section aria-label={title} data-dismissible={String(dismissible)}>
      <button type="button" aria-label="模擬關閉預覽" disabled={!dismissible} onClick={onClose} />
      {children}
      {footer}
    </section>
  ),
}))
vi.mock('./RoutePreviewMap', () => ({
  default: () => <div aria-label="路線地圖預覽" />,
}))

import RoutePreviewModal from './RoutePreviewModal'

function schedule(id: string, title: string, order: number, startTime?: string): Schedule {
  return {
    id,
    tripId: 'trip-1',
    date: '2026-07-21',
    order,
    title,
    category: 'activity',
    timeMode: startTime ? 'preferred' : 'flexible',
    durationMinutes: 60,
    ...(startTime ? { startTime } : {}),
    location: {
      status: 'resolved',
      place: {
        provider: 'geoapify',
        providerPlaceId: `place-${id}`,
        name: title,
        lat: 35.31 + order * 0.01,
        lng: 139.53 + order * 0.01,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      },
    },
    memberIds: ['u1'],
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: { toMillis: () => 0 } as Schedule['createdAt'],
    updatedAt: { toMillis: () => 0 } as Schedule['updatedAt'],
  }
}

function preview(): RoutePreview {
  return {
    previewRevision: 'revision-1234567890',
    scheduleInputHash: 'input-hash-123456',
    payloadHash: 'payload-hash-12345',
    previewToken: 'preview-token-with-more-than-thirty-two-characters',
    expiresAt: '2026-07-21T10:00:00.000Z',
    canApply: true,
    routeChanged: true,
    geometryDegraded: false,
    confidence: 'transit-unverified',
    timeConflictScheduleIds: [],
    applyPlan: {
      revision: 'revision-1234567890',
      date: '2026-07-21',
      schedules: [
        { id: 'a', order: 0 },
        { id: 'b', order: 1 },
        { id: 'c', order: 2 },
      ],
    },
    display: { type: 'FeatureCollection', features: [] },
    legs: [
      { legIndex: 0, fromId: 'a', toId: 'b', kind: 'walking', walkingMinutes: 12, geometryAvailable: true },
      {
        legIndex: 1,
        fromId: 'b',
        toId: 'c',
        kind: 'transit-check',
        walkingMinutes: 38,
        geometryAvailable: false,
        transitEstimate: {
          minMinutes: 20,
          maxMinutes: 30,
          basis: 'ors-walking-distance',
        },
      },
    ],
  }
}

describe('RoutePreviewModal', () => {
  beforeEach(() => {
    applyRoutePreview.mockReset()
    requestRoutePreview.mockReset()
    routeErrorMessage.mockReset()
    routeErrorMessage.mockImplementation((reason: unknown) => (
      reason instanceof Error && reason.message.startsWith('Worker 回傳的路線資料格式不相容')
        ? reason.message
        : '路線服務暫時無法使用，請稍後再試'
    ))
  })

  test('allows an explicitly failed preview request to be retried in place', async () => {
    requestRoutePreview
      .mockRejectedValueOnce(new Error('Worker 回傳的路線資料格式不相容，請確認 Worker 已更新'))
      .mockReturnValueOnce(new Promise(() => undefined))

    render(
      <RoutePreviewModal
        isOpen
        tripId="trip-1"
        date="2026-07-21"
        schedules={[]}
        onClose={() => undefined}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Worker 回傳的路線資料格式不相容，請確認 Worker 已更新')
    expect(alert.className).toContain('items-center')
    expect(alert.className).not.toContain('flex-col')
    const retry = screen.getByRole('button', { name: '重新檢查' })
    expect(retry.className).toContain('shrink-0')

    fireEvent.click(retry)

    await waitFor(() => expect(requestRoutePreview).toHaveBeenCalledTimes(2))
    expect(screen.getByText('正在檢查順路…')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新檢查' })).toBeNull()
  })

  test('never renders a backend English detail directly to users', async () => {
    requestRoutePreview.mockRejectedValueOnce(new Error('editor permission is required'))

    render(
      <RoutePreviewModal
        isOpen
        tripId="trip-1"
        date="2026-07-21"
        schedules={[]}
        onClose={() => undefined}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(routeErrorMessage).toHaveBeenCalledWith(expect.any(Error), 'preview')
    expect(alert.textContent).toContain('路線服務暫時無法使用，請稍後再試')
    expect(alert.textContent).not.toContain('editor permission is required')
  })

  test('renders the preview as a stop timeline with a collapsible explanation summary', async () => {
    requestRoutePreview.mockResolvedValue(preview())

    render(
      <RoutePreviewModal
        isOpen
        tripId="trip-1"
        date="2026-07-21"
        schedules={[
          schedule('a', '鎌倉站', 0, '09:40'),
          schedule('b', '長谷站', 1),
          schedule('c', '鎌倉高校前', 2),
        ]}
        onClose={() => undefined}
      />,
    )

    const timeline = await screen.findByRole('region', { name: '站點與路線規劃' })
    const stops = within(timeline).getAllByRole('listitem')
    expect(stops).toHaveLength(3)
    expect(timeline.textContent).toContain('共 3 個地點')
    expect(timeline.textContent).toContain('鎌倉站')
    expect(timeline.textContent).toContain('09:40')
    expect(timeline.textContent).toContain('長谷站')
    expect(timeline.textContent).toContain('時間未定')
    expect(stops[1]?.querySelector('.lucide-clock-3')).toBeNull()
    expect(timeline.textContent).toContain('步行約 12 分鐘')
    expect(timeline.textContent).toContain('大眾運輸估計約 20–30 分鐘')
    const walkingMapLink = screen.getByRole('link', { name: '在 Google 地圖查看鎌倉站到長谷站的步行路線' })
    expect(walkingMapLink).toBeTruthy()
    expect(walkingMapLink.textContent).toBe('地圖')
    expect(walkingMapLink.querySelector('svg[viewBox="0 0 192 192"]')).toBeTruthy()
    expect(screen.getByRole('link', { name: '在 Google 地圖查看長谷站到鎌倉高校前的大眾運輸' })).toBeTruthy()
    expect(within(timeline).getAllByRole('link', { name: /在 Google 地圖查看/ })).toHaveLength(2)
    expect(within(stops[2]!).queryByText(/步行約|大眾運輸估計約/)).toBeNull()

    expect(screen.getByText('已整理為較順路的順序')).toBeTruthy()
    expect(screen.getByText('僅依地點位置整理順序，不含大眾運輸精確時間計算。')).toBeTruthy()
    expect(screen.getByText('長距離時間以 40 km/h 參考速度及 5 分鐘候車估值推算，不代表實際班次與轉乘時間。')).toBeTruthy()

    const collapse = screen.getByRole('button', { name: '收起路線說明' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(collapse)

    expect(screen.getByRole('button', { name: '展開路線說明' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('僅依地點位置整理順序，不含大眾運輸精確時間計算。')).toBeNull()
  })

  test('describes an unchanged route as needing no apply instead of an apply failure', async () => {
    requestRoutePreview.mockResolvedValue({ ...preview(), canApply: false, routeChanged: false })

    render(
      <RoutePreviewModal
        isOpen
        tripId="trip-1"
        date="2026-07-21"
        schedules={[
          schedule('a', '鎌倉站', 0, '09:40'),
          schedule('b', '長谷站', 1),
          schedule('c', '鎌倉高校前', 2),
        ]}
        onClose={() => undefined}
      />,
    )

    expect(await screen.findByText('目前順序已相當順暢，無需套用')).toBeTruthy()
    expect(screen.queryByText('預覽完成，但目前無法套用')).toBeNull()
    expect(screen.getByRole('button', { name: '無需套用' }).hasAttribute('disabled')).toBe(true)
  })

  test('invalidates a stale apply result and offers a fresh preview instead of resubmitting it', async () => {
    requestRoutePreview
      .mockResolvedValueOnce(preview())
      .mockReturnValueOnce(new Promise(() => undefined))
    applyRoutePreview.mockRejectedValueOnce(new WorkerRejected(
      409,
      'schedule constraints changed after preview',
      'PREVIEW_STALE',
    ))
    routeErrorMessage.mockReturnValue('行程已變更，請重新產生預覽')

    render(
      <RoutePreviewModal
        isOpen
        tripId="trip-1"
        date="2026-07-21"
        schedules={[]}
        onClose={() => undefined}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '套用此順序' }))

    expect(await screen.findByText('行程已變更，請重新產生預覽')).toBeTruthy()
    const retry = screen.getByRole('button', { name: '重新檢查' })
    expect(screen.getByRole('button', { name: '套用此順序' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(retry)
    await waitFor(() => expect(requestRoutePreview).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('行程已變更，請重新產生預覽')).toBeNull()
  })

  test('locks every dismiss path while an apply transaction is unresolved', async () => {
    let resolveApply!: () => void
    requestRoutePreview.mockResolvedValueOnce(preview())
    applyRoutePreview.mockReturnValueOnce(new Promise(resolve => { resolveApply = () => resolve({
      status: 'applied',
      revision: 'revision-1234567890',
    }) }))
    const onClose = vi.fn()

    render(
      <RoutePreviewModal
        isOpen
        tripId="trip-1"
        date="2026-07-21"
        schedules={[]}
        onClose={onClose}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: '套用此順序' }))

    const sheet = screen.getByRole('region', { name: '順路整理預覽' })
    expect(sheet.getAttribute('data-dismissible')).toBe('false')
    expect(screen.getByRole('button', { name: '取消' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '模擬關閉預覽' }))
    expect(onClose).not.toHaveBeenCalled()

    resolveApply()
    await waitFor(() => expect(sheet.getAttribute('data-dismissible')).toBe('true'))
  })
})
