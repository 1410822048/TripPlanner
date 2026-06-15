// src/features/wish/components/WishListSkeleton.tsx
// Placeholder mirroring the consensus-leaderboard rows.
//
// `embedded` 時(WishPageSkeleton,chunk 載入中)整頁尚無真按鈕,所以補一個
// 追加バー placeholder。雲端 wishes 載入中(WishPage scroll 區)真「候補を追加」
// 按鈕已固定在 scroll 區上方,這裡再放 placeholder 會雙重 CTA + 載入完高度跳掉,
// 故非 embedded 不渲染它。
//
// Matches the current WishCard layout so load → content doesn't shift:
//   左の順位インジケータ(w-5)→ サムネ(全順位で同寸 56)→
//   本文列(タイトル / 賛成度バー + ラベル / 投票者 + 投票ボタン)。説明行は無し
//   (1〜3 位の高さを完全に揃えるためカードからは出さない)。
import { SkeletonBar, SkeletonContainer } from '@/components/ui/skeleton'

const TIERS = {
  // 全順位で同寸(サムネ 56 / lg バー / pill 投票ボタン)。差は ring(本命のみ金)
  // とタイトル幅だけ。
  lead:  { wrap: 'ring-1 ring-warn/35',      thumb: 'w-14 h-14', title: 'w-[58%]', bar: 'h-2', pill: true },
  medal: { wrap: 'ring-1 ring-black/[0.06]', thumb: 'w-14 h-14', title: 'w-[50%]', bar: 'h-2', pill: true },
  rest:  { wrap: 'ring-1 ring-black/[0.06]', thumb: 'w-14 h-14', title: 'w-[44%]', bar: 'h-2', pill: true },
} as const

function Row({ tier }: { tier: keyof typeof TIERS }) {
  const t = TIERS[tier]
  return (
    <div className={['bg-surface flex items-center gap-2.5 p-2 rounded-[18px]', t.wrap].join(' ')}>
      {/* 順位インジケータ枠(crown / 番号サークル) */}
      <div className="w-5 shrink-0 flex items-center justify-center">
        <div className="w-[18px] h-[18px] rounded-full bg-tile" />
      </div>
      {/* サムネ */}
      <div className={[t.thumb, 'rounded-[14px] bg-tile shrink-0'].join(' ')} />
      {/* 本文列 */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <SkeletonBar className={['h-[14px]', t.title].join(' ')} />
        {/* 賛成度バー + 「X 票 (Y%)」ラベル */}
        <div className="flex items-center gap-3">
          <div className={['flex-1 rounded-full bg-tile', t.bar].join(' ')} />
          <SkeletonBar className="h-[12px] w-10" />
        </div>
        {/* 投票者アバター + 投票ボタン */}
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
