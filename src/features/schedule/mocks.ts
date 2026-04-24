// src/features/schedule/mocks.ts
// Demo 資料：signed-out 時顯示的示範行程，讓使用者不登入也能預覽 App。
// Cloud mode（signed-in 且有 trips）會完全繞開這份資料。
import type { Schedule } from '@/types'
import type { TripItem, TripMember } from './types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

export const MOCK_SCHEDULES: Schedule[] = [
  { id:'1', tripId:'demo', date:'2026-05-01', order:0, title:'抵達成田機場',        description:'NH802 · 10:30 抵達', category:'transport',     startTime:'10:30', endTime:'12:00', estimatedCost:0,    location:{ name:'成田國際機場' },   createdBy:'demo', createdAt:TS, updatedAt:TS },
  { id:'2', tripId:'demo', date:'2026-05-01', order:1, title:'入住 Dormy Inn 淺草', description:'Check-in 15:00',      category:'accommodation', startTime:'15:00',               estimatedCost:4200, location:{ name:'Dormy Inn 淺草' }, createdBy:'demo', createdAt:TS, updatedAt:TS },
  { id:'3', tripId:'demo', date:'2026-05-01', order:2, title:'淺草雷門 & 仲見世通',                                    category:'activity',      startTime:'17:00', endTime:'19:00', estimatedCost:0,    location:{ name:'淺草雷門' },       createdBy:'demo', createdAt:TS, updatedAt:TS },
  { id:'4', tripId:'demo', date:'2026-05-01', order:3, title:'晚餐　壽司大',        description:'築地場外市場',         category:'food',          startTime:'19:30', endTime:'21:00', estimatedCost:3500, location:{ name:'壽司大 築地' },    createdBy:'demo', createdAt:TS, updatedAt:TS },
  { id:'5', tripId:'demo', date:'2026-05-02', order:0, title:'新宿御苑賞花',                                            category:'activity',      startTime:'10:00', endTime:'13:00', estimatedCost:500,  location:{ name:'新宿御苑' },       createdBy:'demo', createdAt:TS, updatedAt:TS },
  { id:'6', tripId:'demo', date:'2026-05-02', order:1, title:'澀谷購物',            description:'SCRAMBLE SQUARE',    category:'shopping',      startTime:'14:00', endTime:'18:00', estimatedCost:8000, location:{ name:'澀谷' },           createdBy:'demo', createdAt:TS, updatedAt:TS },
  { id:'7', tripId:'demo', date:'2026-05-03', order:0, title:'築地市場早餐',                                            category:'food',          startTime:'07:30', endTime:'09:00', estimatedCost:1200, location:{ name:'築地場外市場' },   createdBy:'demo', createdAt:TS, updatedAt:TS },
]

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
