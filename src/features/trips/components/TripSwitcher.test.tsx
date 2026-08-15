import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TripItem } from '@/features/trips/types'
import TripSwitcher from './TripSwitcher'

const trips: TripItem[] = [
  {
    id: 'trip-1', title: 'Tokyo', dest: 'Tokyo', emoji: '✈️',
    startDate: '2026-09-18', endDate: '2026-09-22', members: [],
    ownedByMe: true, currency: 'JPY', defaultCountryCode: 'JP',
  },
  {
    id: 'trip-2', title: 'Osaka', dest: 'Osaka', emoji: '🚅',
    startDate: '2026-10-01', endDate: '2026-10-03', members: [],
    ownedByMe: true, currency: 'JPY', defaultCountryCode: 'JP',
  },
]

// `isOwner` is PURE ownership identity and `writeEnabled` is the Schema
// Epoch capability — passed separately on purpose, so these tests exercise
// the real contract (a stale owner is isOwner=true, writeEnabled=false).
function renderSwitcher({ isOwner, writeEnabled }: { isOwner: boolean; writeEnabled: boolean }) {
  return render(
    <TripSwitcher
      trips={trips}
      selected={trips[0]!}
      onSelect={vi.fn()}
      onAction={vi.fn()}
      onDelete={vi.fn()}
      onReorder={vi.fn()}
      onCreateTrip={vi.fn()}
      onScanInvite={vi.fn()}
      canDeleteLast
      isOwner={isOwner}
      writeEnabled={writeEnabled}
    />,
  )
}

function openEditMode() {
  fireEvent.click(screen.getByRole('button', { name: /目前旅程：Tokyo/ }))
  fireEvent.click(screen.getByRole('button', { name: '編輯' }))
}

describe('TripSwitcher Schema Epoch affordances', () => {
  it('hides write actions from a STALE owner while identity stays intact', () => {
    // The interesting cell: still the owner, bundle out of date. Folding the
    // two props into one value would make this indistinguishable from a
    // non-owner and hide the case this guards.
    renderSwitcher({ isOwner: true, writeEnabled: false })
    openEditMode()

    expect(screen.queryByRole('button', { name: '刪除 Tokyo' })).toBeNull()
    expect(screen.queryByRole('button', { name: '新旅程' })).toBeNull()
    expect(screen.queryByRole('button', { name: /複製行程/ })).toBeNull()
    expect(screen.getByRole('button', { name: /管理成員/ })).toBeTruthy()
  })

  it('offers deletion to a compatible owner', () => {
    renderSwitcher({ isOwner: true, writeEnabled: true })
    openEditMode()

    expect(screen.getByRole('button', { name: '刪除 Tokyo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新旅程' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /複製行程/ })).toBeTruthy()
  })

  it('hides owner-only entries from a compatible non-owner', () => {
    renderSwitcher({ isOwner: false, writeEnabled: true })
    fireEvent.click(screen.getByRole('button', { name: /目前旅程：Tokyo/ }))

    expect(screen.queryByRole('button', { name: /分享行程/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /編輯行程資訊/ })).toBeNull()
    expect(screen.getByRole('button', { name: /複製行程/ })).toBeTruthy()
  })
})
