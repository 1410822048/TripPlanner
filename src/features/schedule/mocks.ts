// src/features/schedule/mocks.ts
// Demo schedule items keyed to INITIAL_TRIPS[0] (id='demo'). Cloud mode
// (signed-in + has trips) bypasses this entirely; non-'demo' demo trips
// render an empty schedule so the empty-state UI is visible too.
import type { Schedule } from '@/types'
import { DEMO_AUDIT } from '@/utils/audit'

function demoPlace(id: string, name: string, lat: number, lng: number, address?: string) {
  return {
    status: 'resolved' as const,
    place: {
      provider: 'geoapify' as const,
      providerPlaceId: `demo-${id}`,
      name,
      ...(address ? { address } : {}),
      lat,
      lng,
      timeZone: 'Asia/Tokyo',
      countryCode: 'JP',
    },
  }
}

const NO_ROUTE = { routeRevision: null, travelToNext: null } as const

export const MOCK_SCHEDULES: Schedule[] = [
  { id:'1', tripId:'demo', date:'2026-05-01', order:0, title:'抵達成田機場',        description:'NH802 · 10:30 抵達', category:'transport',     startTime:'10:30', timeMode:'preferred', durationMinutes:90, location:demoPlace('nrt', '成田國際機場', 35.7720, 140.3929), ...NO_ROUTE, ...DEMO_AUDIT },
  { id:'2', tripId:'demo', date:'2026-05-01', order:1, title:'入住 Dormy Inn EXPRESS 淺草', description:'Check-in 15:00', category:'accommodation', startTime:'15:00', timeMode:'preferred', durationMinutes:60, estimatedCostMinor:4200, location:demoPlace('dormy-asakusa', 'Dormy Inn EXPRESS 淺草', 35.7119557, 139.7989133, '東京都台東区花川戸1-3-4'), ...NO_ROUTE, ...DEMO_AUDIT },
  { id:'3', tripId:'demo', date:'2026-05-01', order:2, title:'淺草雷門 & 仲見世通',                                    category:'activity',      startTime:'17:00', timeMode:'preferred', durationMinutes:120, estimatedCostMinor:0,    location:demoPlace('kaminarimon', '淺草雷門', 35.7107, 139.7966), ...NO_ROUTE, ...DEMO_AUDIT },
  { id:'4', tripId:'demo', date:'2026-05-01', order:3, title:'晚餐　壽司大',        description:'築地場外市場',         category:'food',          startTime:'19:30', timeMode:'preferred', durationMinutes:90, estimatedCostMinor:3500, location:demoPlace('sushi-dai', '壽司大 築地', 35.6655, 139.7707), ...NO_ROUTE, ...DEMO_AUDIT },
  { id:'5', tripId:'demo', date:'2026-05-02', order:0, title:'新宿御苑賞花',                                            category:'activity',      startTime:'10:00', timeMode:'preferred', durationMinutes:180, estimatedCostMinor:500,  location:demoPlace('shinjuku-gyoen', '新宿御苑', 35.6852, 139.7100), ...NO_ROUTE, ...DEMO_AUDIT },
  { id:'6', tripId:'demo', date:'2026-05-02', order:1, title:'澀谷購物',            description:'SCRAMBLE SQUARE',    category:'shopping',      startTime:'14:00', timeMode:'preferred', durationMinutes:240, estimatedCostMinor:8000, location:demoPlace('shibuya', '澀谷', 35.6580, 139.7016), ...NO_ROUTE, ...DEMO_AUDIT },
  { id:'7', tripId:'demo', date:'2026-05-03', order:0, title:'築地市場早餐',                                            category:'food',          startTime:'07:30', timeMode:'preferred', durationMinutes:90, estimatedCostMinor:1200, location:demoPlace('tsukiji', '築地場外市場', 35.6655, 139.7707), ...NO_ROUTE, ...DEMO_AUDIT },
]
