// src/features/planning/mocks.ts
// Demo plan items for the 'demo' trip — populates each category so the
// section-grouped layout is visible in preview mode.
import type { PlanItem } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

export const MOCK_PLAN_ITEMS: PlanItem[] = [
  // 必備
  { id: 'p1', tripId: 'demo', category: 'essentials', title: 'パスポート（残存 6 ヶ月以上）',
    done: true, createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p2', tripId: 'demo', category: 'essentials', title: '現金（5 万円）+ クレジットカード',
    done: false, createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p3', tripId: 'demo', category: 'essentials', title: 'スマホ + モバイルバッテリー',
    done: false, createdBy: 'demo', createdAt: TS, updatedAt: TS },

  // 予約確認
  { id: 'p4', tripId: 'demo', category: 'documents', title: 'フライト予約（往復）',
    note: '出発 5/1 07:30、帰国 5/8 18:00', done: true,
    createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p5', tripId: 'demo', category: 'documents', title: 'ホテル予約（4 泊）',
    note: 'Dormy Inn 淺草', done: true,
    createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p6', tripId: 'demo', category: 'documents', title: '海外旅行保険',
    done: false, createdBy: 'demo', createdAt: TS, updatedAt: TS },

  // 荷物
  { id: 'p7', tripId: 'demo', category: 'packing', title: '衣類 5 日分',
    note: 'インナー + アウター + 部屋着', done: false,
    createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p8', tripId: 'demo', category: 'packing', title: '充電器 + 変換プラグ',
    done: false, createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p9', tripId: 'demo', category: 'packing', title: '常備薬',
    note: '頭痛薬・胃薬・絆創膏', done: false,
    createdBy: 'demo', createdAt: TS, updatedAt: TS },

  // 行前 todo
  { id: 'p10', tripId: 'demo', category: 'todo', title: '空港リムジン予約',
    done: false, createdBy: 'demo', createdAt: TS, updatedAt: TS },
  { id: 'p11', tripId: 'demo', category: 'todo', title: '両替',
    note: '銀行 vs 空港比較', done: false,
    createdBy: 'demo', createdAt: TS, updatedAt: TS },
]
