// src/features/trips/mocks.ts
// Demo trips + member chips shown when signed-out so the app is usable in
// preview mode. Cloud mode (signed-in with trips) bypasses this entirely.
import type { TripItem, TripMember } from './types'

export const DEMO_MEMBERS: TripMember[] = [
  { id:'m1', label:'我', color:'#3A7858', bg:'#C6DDD6' },
  { id:'m2', label:'友', color:'#4A6FA0', bg:'#BDC9DC' },
  { id:'m3', label:'伴', color:'#9A6840', bg:'#DDC9B2' },
  { id:'m4', label:'隊', color:'#724888', bg:'#CEBEDD' },
]

export const INITIAL_TRIPS: TripItem[] = [
  { id:'demo',  title:'東京五日間',   dest:'東京 · 淺草 · 新宿',   emoji:'🗼', startDate:'2026-05-01', endDate:'2026-05-08', members:DEMO_MEMBERS },
  { id:'trip2', title:'京都賞楓之旅', dest:'京都 · 嵐山 · 奈良',   emoji:'🍁', startDate:'2026-11-10', endDate:'2026-11-14', members:DEMO_MEMBERS.slice(0, 2) },
  { id:'trip3', title:'北海道雪祭',   dest:'札幌 · 函館 · 富良野', emoji:'⛄', startDate:'2027-02-05', endDate:'2027-02-09', members:DEMO_MEMBERS.slice(0, 3) },
]
