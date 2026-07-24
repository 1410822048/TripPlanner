// src/features/schedule/mocks.ts
// Demo schedule items keyed to INITIAL_TRIPS[0] (id='demo'). Cloud mode
// (signed-in + has trips) bypasses this entirely; non-'demo' demo trips
// render an empty schedule so the empty-state UI is visible too.
import type { Schedule } from '@/types'
import { DEMO_AUDIT } from '@/utils/audit'

const unresolved = (query: string) => ({ status: 'unresolved' as const, query })

export const MOCK_SCHEDULES: Schedule[] = [
  { id:'1', tripId:'demo', date:'2026-05-01', order:0, title:'抵達成田機場',        description:'NH802 · 10:30 抵達', category:'transport',     startTime:'10:30', timeMode:'preferred', durationMinutes:90, location:unresolved('成田國際機場'),   ...DEMO_AUDIT },
  { id:'2', tripId:'demo', date:'2026-05-01', order:1, title:'入住 Dormy Inn 淺草', description:'Check-in 15:00',      category:'accommodation', startTime:'15:00',               timeMode:'preferred', durationMinutes:60, estimatedCostMinor:4200, location:unresolved('Dormy Inn 淺草'), ...DEMO_AUDIT },
  { id:'3', tripId:'demo', date:'2026-05-01', order:2, title:'淺草雷門 & 仲見世通',                                    category:'activity',      startTime:'17:00', timeMode:'preferred', durationMinutes:120, estimatedCostMinor:0,    location:unresolved('淺草雷門'),       ...DEMO_AUDIT },
  { id:'4', tripId:'demo', date:'2026-05-01', order:3, title:'晚餐　壽司大',        description:'築地場外市場',         category:'food',          startTime:'19:30', timeMode:'preferred', durationMinutes:90, estimatedCostMinor:3500, location:unresolved('壽司大 築地'),    ...DEMO_AUDIT },
  { id:'5', tripId:'demo', date:'2026-05-02', order:0, title:'新宿御苑賞花',                                            category:'activity',      startTime:'10:00', timeMode:'preferred', durationMinutes:180, estimatedCostMinor:500,  location:unresolved('新宿御苑'),       ...DEMO_AUDIT },
  { id:'6', tripId:'demo', date:'2026-05-02', order:1, title:'澀谷購物',            description:'SCRAMBLE SQUARE',    category:'shopping',      startTime:'14:00', timeMode:'preferred', durationMinutes:240, estimatedCostMinor:8000, location:unresolved('澀谷'),           ...DEMO_AUDIT },
  { id:'7', tripId:'demo', date:'2026-05-03', order:0, title:'築地市場早餐',                                            category:'food',          startTime:'07:30', timeMode:'preferred', durationMinutes:90, estimatedCostMinor:1200, location:unresolved('築地場外市場'),   ...DEMO_AUDIT },
]
