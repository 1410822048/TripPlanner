// src/features/wish/components/WishListSkeleton.tsx
// Placeholder mirroring the consensus-leaderboard rows.
//
// `embedded` 時(WishPageSkeleton,chunk 載入中)整頁尚無真按鈕,所以補一個
// 新增列 placeholder。雲端 wishes 載入中(WishPage scroll 區)真「新增候選項目」
// 按鈕已固定在 scroll 區上方,這裡再放 placeholder 會雙重 CTA + 載入完高度跳掉,
// 故非 embedded 不渲染它。
//
// Matches the current WishCard layout so load → content doesn't shift:
//   左側名次指示器(w-5)→ 縮圖(所有名次同尺寸 56)→
//   內文欄(標題 / 贊成度條 + 標籤 / 投票者 + 投票按鈕)。沒有說明列
//   (為了讓第 1〜3 名高度完全一致,卡片不顯示說明)。
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

const TIERS = {
  // 所有名次同尺寸(縮圖 56 / lg 條 / pill 投票按鈕)。差別只有 ring(僅第一名為金色)
  // 與標題寬度。
  lead:  { wrap: 'ring-1 ring-warn/35',      thumb: 'w-14 h-14', title: 'w-[58%]', bar: 'h-2', pill: true },
  medal: { wrap: 'ring-1 ring-black/[0.06]', thumb: 'w-14 h-14', title: 'w-[50%]', bar: 'h-2', pill: true },
  rest:  { wrap: 'ring-1 ring-black/[0.06]', thumb: 'w-14 h-14', title: 'w-[44%]', bar: 'h-2', pill: true },
} as const

function Row({ tier }: { tier: keyof typeof TIERS }) {
  const t = TIERS[tier]
  return (
    <div className={['bg-surface flex items-center gap-2.5 p-2 rounded-[18px]', t.wrap].join(' ')}>
      {/* 名次指示器框(crown / 號碼圓圈) */}
      <div className="w-5 shrink-0 flex items-center justify-center">
        <div className="w-[18px] h-[18px] rounded-full bg-tile" />
      </div>
      {/* 縮圖 */}
      <div className={[t.thumb, 'rounded-[14px] bg-tile shrink-0'].join(' ')} />
      {/* 本文列 */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <SkeletonBar className={['h-[14px]', t.title].join(' ')} />
        {/* 贊成度條 + 「X 票 (Y%)」標籤 */}
        <div className="flex items-center gap-3">
          <div className={['flex-1 rounded-full bg-tile', t.bar].join(' ')} />
          <SkeletonBar className="h-[12px] w-10" />
        </div>
        {/* 投票者頭像 + 投票按鈕 */}
        <div className="flex items-center gap-2">
          <div className="flex">
            <div className="w-5 h-5 rounded-full bg-tile border-[1.5px] border-surface" />
            <div className="w-5 h-5 rounded-full bg-tile border-[1.5px] border-surface -ml-1.5" />
          </div>
          <div className={['ml-auto rounded-full bg-tile', t.pill ? 'h-7 w-16' : 'h-7 w-7'].join(' ')} />
        </div>
      </div>
    </div>
  )
}

export default function WishListSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <SkeletonContainer embedded={embedded}>
      <div className="flex flex-col gap-3">
        {embedded && <div className="h-12 w-full rounded-[16px] bg-tile" />}
        <Row tier="lead" />
        <Row tier="medal" />
        <Row tier="medal" />
        <Row tier="rest" />
      </div>
    </SkeletonContainer>
  )
}
