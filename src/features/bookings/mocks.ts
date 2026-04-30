// src/features/bookings/mocks.ts
// Demo bookings shown alongside MOCK_SCHEDULES / MOCK_EXPENSES for the
// 'demo' trip (東京五日間). Other demo trips render empty so the user can
// see the empty state UI as well.
import type { Booking } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

export const MOCK_BOOKINGS: Booking[] = [
  {
    id: 'b1', tripId: 'demo', type: 'flight',
    origin: '桃園', destination: '成田',
    title: 'NH802',
    confirmationCode: 'ABC123',
    provider: 'ANA',
    checkIn: '2026-05-01T07:30',
    note: 'Terminal 1 · 06:30 報到',
    createdAt: TS,
  },
  {
    id: 'b2', tripId: 'demo', type: 'hotel',
    title: 'Dormy Inn 淺草',
    confirmationCode: 'DI-7745201',
    provider: 'Booking.com',
    checkIn: '2026-05-01', checkOut: '2026-05-05',
    createdAt: TS,
  },
  {
    id: 'b3', tripId: 'demo', type: 'train',
    origin: '東京駅', destination: '京都駅',
    title: 'のぞみ47号',
    confirmationCode: 'JRP-XX9921',
    provider: 'JR Central',
    checkIn: '2026-05-02',
    note: 'グリーン車 5号車',
    createdAt: TS,
  },
  {
    id: 'b4', tripId: 'demo', type: 'flight',
    origin: '成田', destination: '桃園',
    title: 'NH801',
    confirmationCode: 'ABC123',
    provider: 'ANA',
    checkIn: '2026-05-08T18:00',
    createdAt: TS,
  },
]
