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
  { id: 'p1', tripId: 'demo', category: 'essentials', title: '護照（效期至少剩 6 個月）',
    completedBy: completedBy('m1', 'm2', 'm3', 'm4'), ...DEMO_PLAN_AUDIT },
  { id: 'p2', tripId: 'demo', category: 'essentials', title: '現金（5 萬日圓）+ 信用卡',
    completedBy: completedBy('m1'), ...DEMO_PLAN_AUDIT },
  { id: 'p3', tripId: 'demo', category: 'essentials', title: '手機 + 行動電源',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },

  // 予約確認
  { id: 'p4', tripId: 'demo', category: 'documents', title: '航班訂單（來回）',
    note: '出發 5/1 07:30，回程 5/8 18:00', completedBy: completedBy('m1', 'm2'),
    ...DEMO_PLAN_AUDIT },
  { id: 'p5', tripId: 'demo', category: 'documents', title: '飯店訂單（4 晚）',
    note: 'Dormy Inn 淺草', completedBy: completedBy('m1', 'm2', 'm3'),
    ...DEMO_PLAN_AUDIT },
  { id: 'p6', tripId: 'demo', category: 'documents', title: '海外旅遊保險',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },

  // 荷物
  { id: 'p7', tripId: 'demo', category: 'packing', title: '5 天份衣物',
    note: '內搭 + 外套 + 睡衣', completedBy: completedBy('m1'),
    ...DEMO_PLAN_AUDIT },
  { id: 'p8', tripId: 'demo', category: 'packing', title: '充電器 + 轉接插頭',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },
  { id: 'p9', tripId: 'demo', category: 'packing', title: '常備藥品',
    note: '頭痛藥、胃藥、OK 繃', completedBy: completedBy('m2'),
    ...DEMO_PLAN_AUDIT },

  // 行前 todo
  { id: 'p10', tripId: 'demo', category: 'todo', title: '機場接駁巴士預約',
    completedBy: completedBy(), ...DEMO_PLAN_AUDIT },
  { id: 'p11', tripId: 'demo', category: 'todo', title: '換匯',
    note: '比較銀行與機場匯率', completedBy: completedBy('m1', 'm3'), ...DEMO_PLAN_AUDIT },
]
