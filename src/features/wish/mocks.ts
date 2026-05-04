// src/features/wish/mocks.ts
// Demo wish items for the 'demo' trip (東京五日間). All votes are
// pre-populated with the demo author so the heart count visibly varies
// across the list — gives users a feel for the popularity sort.
import type { Wish } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

export const MOCK_WISHES: Wish[] = [
  {
    id: 'w1', tripId: 'demo',
    category: 'food',
    title: '壽司大（築地）',
    description: '築地場外の老舗。朝食に並んででも食べたい',
    link: 'https://maps.google.com/?q=壽司大+築地',
    proposedBy: 'demo',
    votes: ['demo', 'm2', 'm3', 'm4'],
    createdAt: TS, updatedAt: TS,
  },
  {
    id: 'w2', tripId: 'demo',
    category: 'place',
    title: '新宿御苑',
    description: '桜・つつじ・新緑、季節を問わず見応えあり',
    proposedBy: 'demo',
    votes: ['demo', 'm2', 'm3'],
    createdAt: TS, updatedAt: TS,
  },
  {
    id: 'w3', tripId: 'demo',
    category: 'place',
    title: '隅田川ナイトクルーズ',
    description: '夜景を眺めながら 1 時間のクルーズ',
    proposedBy: 'm2',
    votes: ['demo', 'm2'],
    createdAt: TS, updatedAt: TS,
  },
  {
    id: 'w4', tripId: 'demo',
    category: 'food',
    title: '一蘭ラーメン',
    proposedBy: 'm3',
    votes: ['m3'],
    createdAt: TS, updatedAt: TS,
  },
]
