// src/features/expense/mocks.ts
// Demo 費用資料（搭配 INITIAL_TRIPS[0] 東京五日間 / m1-m4）
// 僅在 signed-out 且 selected demo trip id === 'demo' 時顯示。
import type { Expense } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'
import { splitEqually as equal } from './utils'

export const MOCK_EXPENSES: Expense[] = [
  {
    id:'e1', tripId:'demo', title:'成田機場特快',  amount:14000, currency:'JPY', category:'transport',
    paidBy:'m1', splits: equal(14000, ['m1','m2','m3','m4']),
    date:'2026-05-01', createdBy:'demo', createdAt:TS, updatedAt:TS,
  },
  {
    id:'e2', tripId:'demo', title:'Dormy Inn 淺草（4泊）', amount:67200, currency:'JPY', category:'accommodation',
    paidBy:'m2', splits: equal(67200, ['m1','m2','m3','m4']),
    date:'2026-05-01', createdBy:'demo', createdAt:TS, updatedAt:TS,
  },
  {
    id:'e3', tripId:'demo', title:'壽司大 築地',   amount:14000, currency:'JPY', category:'food',
    paidBy:'m1', splits: equal(14000, ['m1','m2','m3','m4']),
    date:'2026-05-01', createdBy:'demo', createdAt:TS, updatedAt:TS,
  },
  {
    id:'e4', tripId:'demo', title:'新宿御苑入場料', amount:2000, currency:'JPY', category:'activity',
    paidBy:'m3', splits: equal(2000, ['m1','m2','m3','m4']),
    date:'2026-05-02', createdBy:'demo', createdAt:TS, updatedAt:TS,
  },
  {
    id:'e5', tripId:'demo', title:'澀谷購物（個人）', amount:12000, currency:'JPY', category:'shopping',
    paidBy:'m4',
    // 自訂：m3 不參與 · m4 額外購入
    splits:[
      { memberId:'m1', amount:3000 },
      { memberId:'m2', amount:3000 },
      { memberId:'m4', amount:6000 },
    ],
    date:'2026-05-02', createdBy:'demo', createdAt:TS, updatedAt:TS,
  },
  {
    id:'e6', tripId:'demo', title:'築地市場早餐',  amount:4800, currency:'JPY', category:'food',
    paidBy:'m2', splits: equal(4800, ['m1','m2','m3','m4']),
    date:'2026-05-03', createdBy:'demo', createdAt:TS, updatedAt:TS,
  },
]
