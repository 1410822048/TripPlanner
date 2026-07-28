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
    expect(screen.getByText('大眾運輸估計約 10–15 分鐘')).toBeTruthy()
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

    expect(screen.getByText(/步行估計約/)).toBeTruthy()
    expect(container.querySelector('.lucide-footprints')).not.toBeNull()
  })

  test('prefers the applied route estimate when adjacent revisions match', () => {
    const revision = 'revision-1234567890'
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      routeRevision: revision,
      travelToNext: { toId: 'b', kind: 'walking', minutes: 6 },
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

    expect(screen.getByText('步行估計約 6 分鐘')).toBeTruthy()
    expect(screen.queryByText(/大眾運輸估計/)).toBeNull()
    expect(container.querySelector('.lucide-footprints')).not.toBeNull()
  })

  test('falls back to the local estimate when travelToNext targets another schedule', () => {
    const revision = 'revision-1234567890'
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      routeRevision: revision,
      travelToNext: { toId: 'c', kind: 'walking', minutes: 1 },
    })
    const second = schedule({ id: 'b', title: '長谷寺', order: 1, routeRevision: revision })

    renderTimeline([first, second])

    expect(screen.queryByText('步行估計約 1 分鐘')).toBeNull()
    expect(screen.getByText(/大眾運輸估計/)).toBeTruthy()
  })

  test('falls back to the local estimate when adjacent revisions differ', () => {
    const first = schedule({
      id: 'a',
      title: '鎌倉站',
      order: 0,
      routeRevision: 'revision-1234567890',
      travelToNext: { toId: 'b', kind: 'walking', minutes: 1 },
    })
    const second = schedule({ id: 'b', title: '長谷寺', order: 1, routeRevision: 'revision-other-1234' })

    renderTimeline([first, second])

    expect(screen.queryByText('步行估計約 1 分鐘')).toBeNull()
    expect(screen.getByText(/大眾運輸估計/)).toBeTruthy()
  })
})
