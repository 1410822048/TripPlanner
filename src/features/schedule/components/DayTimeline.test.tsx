import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { Schedule } from '@/types'
import DayTimeline from './DayTimeline'

function schedule(overrides: Partial<Schedule> & Pick<Schedule, 'id' | 'title' | 'order'>): Schedule {
  return {
    tripId: 'trip-1',
    date: '2026-07-21',
    category: 'activity',
    timeMode: 'preferred',
    startTime: '09:00',
    durationMinutes: 60,
    routeRevision: null,
    travelToNext: null,
    location: {
      status: 'resolved',
      place: {
        provider: 'geoapify',
        providerPlaceId: `place-${overrides.id}`,
        name: `${overrides.title}地點`,
        lat: 35.31 + overrides.order * 0.01,
        lng: 139.53 + overrides.order * 0.01,
        timeZone: 'Asia/Tokyo',
        countryCode: 'JP',
      },
    },
    createdBy: 'u1',
    updatedBy: 'u1',
    memberIds: ['u1'],
    createdAt: { toMillis: () => 0 } as Schedule['createdAt'],
    updatedAt: { toMillis: () => 0 } as Schedule['updatedAt'],
    ...overrides,
  }
}

function renderTimeline(
  items: Schedule[],
  overrides: Partial<ComponentProps<typeof DayTimeline>> = {},
) {
  return render(
    <DayTimeline
      display="2026-07-21"
      items={items}
      dayTotal={0}
      isLoading={false}
      canWrite={false}
      roleCanWrite={false}
      currency="JPY"
      routeAction={undefined}
      onAdd={vi.fn()}
      onOpenDetails={vi.fn()}
      {...overrides}
    />,
  )
}

describe('DayTimeline', () => {
  test('renders schedule metadata and a neutral connector without inventing transport details', () => {
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      description: '先寄放行李',
      estimatedCostMinor: 500,
    })
    const second = schedule({
      id: 'b',
      title: '長谷寺',
      order: 1,
      startTime: undefined,
      timeMode: 'flexible',
      durationMinutes: 90,
      category: 'activity',
    })

    const onOpenDetails = vi.fn()
    const { container } = renderTimeline([first, second], { dayTotal: 500, onOpenDetails })

    expect(screen.getByText('09:00 – 10:00')).toBeTruthy()
    expect(screen.getByText('停留 60 分')).toBeTruthy()
    expect(screen.getByText('時間未定')).toBeTruthy()
    expect(screen.getByText('停留 90 分')).toBeTruthy()
    expect(screen.getByText('備註')).toBeTruthy()
    const noteDisclosure = screen.getByText('備註').closest('details') as HTMLDetailsElement
    expect(noteDisclosure.open).toBe(false)
    fireEvent.click(screen.getByText('備註'))
    expect(noteDisclosure.open).toBe(true)
    expect(screen.getByText('先寄放行李')).toBeTruthy()
    expect(screen.queryByText('儲存')).toBeNull()
    expect(screen.queryByText('取消')).toBeNull()
    expect(onOpenDetails).not.toHaveBeenCalled()
    expect(screen.queryByText('鎌倉站地點 → 長谷寺地點')).toBeNull()
    // ~1.4 km apart: a 23-minute walk is ambiguous, so both modes are shown.
    expect(screen.getByText('大眾運輸約 10–20 分 · 步行約 23 分')).toBeTruthy()
    expect(screen.getByText('路線')).toBeTruthy()
    expect(screen.queryByText('免費')).toBeNull()
    expect(container.querySelector('.lucide-train-front')).not.toBeNull()

    const mapLink = screen.getByRole('link', { name: /在 Google Maps 查看從/ })
    const url = new URL(mapLink.getAttribute('href') ?? '')
    expect(url.hostname).toBe('www.google.com')
    expect(url.searchParams.get('travelmode')).toBe('transit')

    const locationLink = screen.getByRole('link', { name: '在地圖中開啟 鎌倉站地點' })
    expect(locationLink.className.split(' ')).toContain('inline-flex')
    expect(locationLink.className.split(' ')).not.toContain('flex')
  })

  test('keeps unresolved text locations as a two-point Google Maps route', () => {
    const first = schedule({
      id: 'a',
      title: '東京站',
      order: 0,
      location: { status: 'unresolved', query: '東京站' },
    })
    const second = schedule({
      id: 'b',
      title: '淺草雷門',
      order: 1,
      location: { status: 'unresolved', query: '淺草雷門' },
    })

    renderTimeline([first, second])

    expect(screen.getByText('交通時間待確認')).toBeTruthy()
    const url = new URL(screen.getByRole('link', { name: /在 Google Maps 查看從/ }).getAttribute('href') ?? '')
    expect(url.pathname).toBe('/maps/dir/')
    expect(url.searchParams.get('origin')).toBe('東京站')
    expect(url.searchParams.get('destination')).toBe('淺草雷門')
  })

  test('omits the route link instead of throwing for a blank unresolved location', () => {
    const first = schedule({
      id: 'a',
      title: '未命名地點',
      order: 0,
      location: { status: 'unresolved', query: '   ' },
    })
    const second = schedule({ id: 'b', title: '淺草雷門', order: 1 })

    renderTimeline([first, second])

    expect(screen.getByText('交通時間待確認')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /在 Google Maps 查看從/ })).toBeNull()
  })

  test('does not advertise a zero-length transport segment for a single schedule', () => {
    renderTimeline([schedule({ id: 'a', title: '鎌倉站', order: 0 })])

    expect(screen.getByText('1 個行程')).toBeTruthy()
    expect(screen.queryByText(/0 段交通/)).toBeNull()
  })

  test('uses a walking icon for a short verified segment', () => {
    const first = schedule({ id: 'a', title: '起點', order: 0 })
    const second = schedule({
      id: 'b',
      title: '終點',
      order: 1,
      location: {
        status: 'resolved',
        place: {
          provider: 'geoapify',
          providerPlaceId: 'nearby-place',
          name: '附近地點',
          lat: 35.3101,
          lng: 139.5301,
          timeZone: 'Asia/Tokyo',
          countryCode: 'JP',
        },
      },
    })

    const { container } = renderTimeline([first, second])

    expect(screen.getByText(/^步行約 \d+ 分鐘$/)).toBeTruthy()
    expect(container.querySelector('.lucide-footprints')).not.toBeNull()
  })

  test('prefers the applied route estimate when adjacent revisions match', () => {
    const revision = 'revision-1234567890'
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      routeRevision: revision,
      travelToNext: { toId: 'b', walkingMinutes: 6, walkingDistanceMeters: 480 },
    })
    const second = schedule({
      id: 'b',
      title: '長谷寺',
      order: 1,
      routeRevision: revision,
      location: {
        status: 'resolved',
        place: {
          provider: 'geoapify',
          providerPlaceId: 'far-place',
          name: '長谷寺',
          lat: 35.5,
          lng: 139.8,
          timeZone: 'Asia/Tokyo',
          countryCode: 'JP',
        },
      },
    })

    const { container } = renderTimeline([first, second])

    expect(screen.getByText('步行約 6 分鐘')).toBeTruthy()
    // Both start at 09:00, so the measured row also carries the overlap.
    expect(screen.getByText(/^依實際路線/)).toBeTruthy()
    expect(screen.getByText('與上一個行程時間重疊 60 分鐘')).toBeTruthy()
    expect(screen.queryByText(/大眾運輸/)).toBeNull()
    expect(container.querySelector('.lucide-footprints')).not.toBeNull()
  })

  test('falls back to the local estimate when travelToNext targets another schedule', () => {
    const revision = 'revision-1234567890'
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      routeRevision: revision,
      travelToNext: { toId: 'c', walkingMinutes: 1, walkingDistanceMeters: 80 },
    })
    const second = schedule({ id: 'b', title: '長谷寺', order: 1, routeRevision: revision })

    renderTimeline([first, second])

    expect(screen.queryByText('步行約 1 分鐘')).toBeNull()
    expect(screen.getByText(/^大眾運輸約/)).toBeTruthy()
    expect(screen.queryByText('依實際路線')).toBeNull()
  })

  test('falls back to the local estimate when adjacent revisions differ', () => {
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      routeRevision: 'revision-1234567890',
      travelToNext: { toId: 'b', walkingMinutes: 1, walkingDistanceMeters: 80 },
    })
    const second = schedule({ id: 'b', title: '長谷寺', order: 1, routeRevision: 'revision-other-1234' })

    renderTimeline([first, second])

    expect(screen.queryByText('步行約 1 分鐘')).toBeNull()
    expect(screen.getByText(/^大眾運輸約/)).toBeTruthy()
    expect(screen.queryByText('依實際路線')).toBeNull()
  })

  test('flags a reservation that even the fastest estimate misses', () => {
    // 09:00–10:00, then a fixed 10:05: at best 10 minutes away.
    const first = schedule({ id: 'a', title: '鎌倉站', order: 0 })
    const second = schedule({ id: 'b', title: '午餐預約', order: 1, timeMode: 'fixed', startTime: '10:05' })

    renderTimeline([first, second])

    const notice = screen.getByText('依估計至少晚到 5 分鐘')
    expect(notice.className).toContain('text-danger')
    const summary = screen.getByText('1 處預估遲到')
    expect(summary.className).toContain('text-danger')
  })

  test('a preferred time that is only at risk is a warning', () => {
    const first = schedule({ id: 'a', title: '鎌倉站', order: 0 })
    // 10–20 minutes away from a 10:00 end: on time at best, 5 late at worst.
    const second = schedule({ id: 'b', title: '長谷寺', order: 1, startTime: '10:15' })

    renderTimeline([first, second])

    expect(screen.getByText('可能晚到，最多約 5 分鐘').className).toContain('text-warn')
    expect(screen.getByText('1 處可能遲到').className).toContain('text-warn')
  })

  test('does not estimate the segment after a transport schedule', () => {
    const train = schedule({ id: 'a', title: '新幹線', order: 0, category: 'transport' })
    const hotel = schedule({ id: 'b', title: '飯店', order: 1 })

    const { container } = renderTimeline([train, hotel])

    expect(screen.getByText('交通時間待確認')).toBeTruthy()
    expect(container.querySelector('.lucide-circle-help, .lucide-circle-question-mark')).not.toBeNull()
  })

  test('blames the role when a viewer is on an up-to-date bundle', () => {
    renderTimeline([], { canWrite: false, roleCanWrite: false })

    expect(screen.getByText(/以檢視者身分加入/)).toBeTruthy()
  })

  test('blames the stale bundle, not the role, when the write epoch blocks an editor', () => {
    renderTimeline([], { canWrite: false, roleCanWrite: true })

    // canWrite folds in compatibility, so without this second signal an
    // owner/editor on an obsolete build is told they are merely a viewer.
    expect(screen.getByText(/此版本已停止寫入/)).toBeTruthy()
    expect(screen.queryByText(/以檢視者身分加入/)).toBeNull()
  })

  test('never promises a stale-bundle viewer that updating will let them add', () => {
    // Both blockers at once: the role wins. 「更新後即可繼續新增」would be a
    // promise the update cannot deliver — they stay a viewer afterwards.
    renderTimeline([], { canWrite: false, roleCanWrite: false })

    expect(screen.getByText(/以檢視者身分加入/)).toBeTruthy()
    expect(screen.queryByText(/此版本已停止寫入/)).toBeNull()
  })
})
