// src/features/planning/mocks.ts
// Demo plan items for the 'demo' trip — populates each category so the
// section-grouped layout is visible in preview mode.
import type { PlanItem } from '@/types'
import { DEMO_AUDIT } from '@/utils/audit'
import { MOCK_TIMESTAMP } from '@/mocks/utils'

const DEMO_MEMBER_IDS = ['m1', 'm2', 'm3', 'm4'] as const
const DEMO_PLAN_AUDIT = { ...DEMO_AUDIT, memberIds: [...DEMO_MEMBER_IDS] }

function completedBy(...uids: Array<typeof DEMO_MEMBER_IDS[number]>): PlanItem['completedBy'] {
  return Object.fromEntries(uids.map(uid => [uid, MOCK_TIMESTAMP]))
}

export const MOCK_PLAN_ITEMS: PlanItem[] = [
  // 必備
  { id: 'p1', tripId: 'demo', category: 'essentials', title: 'パスポート（残存 6 ヶ月以上）',
    completedBy: completedBy('m1', 'm2', 'm3', 'm4'), ...DEMO_PLAN_AUDIT },
  { id: 'p2', tripId: 'demo', category: 'essentials', title: '現金（5 万円）+ クレジットカード',
    completedBy: completedBy('m1'), ...DEMO_PLAN_AUDIT },
  { id: 'p3', tripId: 'demo', category: 'essentials', title: 'スマホ + モバイルバッテリー',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },

  // 予約確認
  { id: 'p4', tripId: 'demo', category: 'documents', title: 'フライト予約（往復）',
    note: '出発 5/1 07:30、帰国 5/8 18:00', completedBy: completedBy('m1', 'm2'),
    ...DEMO_PLAN_AUDIT },
  { id: 'p5', tripId: 'demo', category: 'documents', title: 'ホテル予約（4 泊）',
    note: 'Dormy Inn 淺草', completedBy: completedBy('m1', 'm2', 'm3'),
    ...DEMO_PLAN_AUDIT },
  { id: 'p6', tripId: 'demo', category: 'documents', title: '海外旅行保険',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },

  // 荷物
  { id: 'p7', tripId: 'demo', category: 'packing', title: '衣類 5 日分',
    note: 'インナー + アウター + 部屋着', completedBy: completedBy('m1'),
    ...DEMO_PLAN_AUDIT },
  { id: 'p8', tripId: 'demo', category: 'packing', title: '充電器 + 変換プラグ',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },
  { id: 'p9', tripId: 'demo', category: 'packing', title: '常備薬',
    note: '頭痛薬・胃薬・絆創膏', completedBy: completedBy('m2'),
    ...DEMO_PLAN_AUDIT },

  // 行前 todo
  { id: 'p10', tripId: 'demo', category: 'todo', title: '空港リムジン予約',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },
  { id: 'p11', tripId: 'demo', category: 'todo', title: '両替',
    note: '銀行 vs 空港比較', completedBy: completedBy('m1', 'm3'), ...DEMO_PLAN_AUDIT },
]
