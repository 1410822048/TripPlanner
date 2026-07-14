// src/features/wish/mocks.ts
// Demo wish items for the 'demo' trip (東京五日間). All votes are
// pre-populated with the demo owner so the heart count visibly varies
// across the list — gives users a feel for the popularity sort.
import type { Wish } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

export const MOCK_WISHES: Wish[] = [
  {
    id: 'w1', tripId: 'demo',
    category: 'food',
    title: '壽司大（築地）',
    description: '築地場外市場的老店，想排隊當早餐吃。',
    address: '東京都中央区築地 4-13-18',
    proposedBy: 'm1',
    updatedBy: 'm1',
    votes: ['m1', 'm2', 'm3', 'm4'],
    memberIds: ['m1', 'm2', 'm3', 'm4'],
    createdAt: TS, updatedAt: TS,
  },
  {
    id: 'w2', tripId: 'demo',
    category: 'place',
    title: '新宿御苑',
    description: '櫻花、杜鵑與新綠，四季都有看頭。',
    address: '新宿御苑',
    proposedBy: 'm1',
    updatedBy: 'm1',
    votes: ['m1', 'm2', 'm3'],
    memberIds: ['m1', 'm2', 'm3', 'm4'],
    createdAt: TS, updatedAt: TS,
  },
  {
    id: 'w3', tripId: 'demo',
    category: 'place',
    title: '隅田川夜間遊船',
    description: '一邊欣賞夜景，一邊搭乘 1 小時遊船。',
    proposedBy: 'm2',
    updatedBy: 'm2',
    votes: ['m1', 'm2'],
    memberIds: ['m1', 'm2', 'm3', 'm4'],
    createdAt: TS, updatedAt: TS,
  },
  {
    id: 'w4', tripId: 'demo',
    category: 'food',
    title: '一蘭拉麵',
    proposedBy: 'm3',
    updatedBy: 'm3',
    votes: ['m3'],
    memberIds: ['m1', 'm2', 'm3', 'm4'],
    createdAt: TS, updatedAt: TS,
  },
]
