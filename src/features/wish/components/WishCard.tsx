// src/features/wish/components/WishCard.tsx
// 投票看板(consensus leaderboard)的候選卡片。Wish 是「大家一起決定目的地」
// 的投票系統,因此版面以排名、贊成度、投票動作為主角
// (由以前的 Pinterest 風 image grid 轉換而來)。
//
// 單一 row 版面。尺寸在所有名次統一(縮圖 56 / 贊成度條 / pill
// 投票按鈕)。名次不靠尺寸,而是以「左側名次指示器(第一名 = 金色王冠、
// 第 2、3 名 = 銀/銅數字圓圈、第 4 名以後 = 中性數字)+ 僅第一名卡片帶金色
// 光暈」表示。縱向排列順序即名次。WishPage 在第 3 名與第 4 名之間插入候選
// 分隔線。
//
// 贊成度 = votes.length / memberCount。approval voting(每人可贊成多個)
// 所以「成員中有幾人想去」比「絕對票數」更有意義。
//
// 互動規範:
//   - tap-to-detail 是「整張卡片」。把覆蓋全卡的透明 button 鋪在子元素的
//     「下方」(z-0),只有操作元素(投票 / ⋮)
//     以 z-10 浮到上層的 stretched-overlay 模式(避免巢狀 button)。
//   - 地圖/網站等外部動作集中在 detail sheet。卡片只負責比較、投票、
//     進入詳細,避免誤觸跳到外部。
//   - ⋮ 選單是 edit/delete 的唯一入口,pending(temp- / isUpdating)期間
//     停用 tap、投票、swipe 並顯示 儲存中…。
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreVertical, Crown } from 'lucide-react'
import type { Wish } from '@/types'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
import PendingIndicator from '@/components/ui/PendingIndicator'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import WishActionMenu from './WishActionMenu'
import { WISH_CATEGORY_ICON } from '../categories'
import type { Consensus } from '../utils'
import WishConsensusBar from './WishConsensusBar'
import WishVoteButton from './WishVoteButton'

/** Avatar chip style 對策 iOS Safari PWA 在 translate3d 父層下的殘影 bug:
 *  子層 mount/unmount 時 Safari 偶爾把 shadow + border 緩存進父層 raster 沒
 *  重畫,留下空心圓殘影。relative + translateZ(0) 雙保險把 chip promote 到
 *  獨立 GPU layer,unmount 時整層丟掉,不跟父層混淆。 */
const AVATAR_LAYER_STYLE: React.CSSProperties = {
  position:  'relative',
  transform: 'translateZ(0)',
}

/** Thumbnail gradient when no image is uploaded — distinct per category so
 *  empty-state cards still feel intentional rather than blank. */
const CATEGORY_GRADIENT: Record<Wish['category'], string> = {
  place: 'linear-gradient(135deg, #d4ecf6 0%, #8fb8d6 100%)',
  food:  'linear-gradient(135deg, #fde2cc 0%, #f0a87a 100%)',
}

/** 漸層上的圖示顏色 — 用各分類的深色調確保對比。 */
const CATEGORY_ICON_COLOR: Record<Wish['category'], string> = {
  place: '#33617f',
  food:  '#b5652e',
}

/** 名次指示器放在卡片左側 gutter(不是縮圖角落的號碼徽章):
 *  第一名(rank 1)= 金色王冠 + 卡片金色光暈,其他 = 中性號碼圓圈 +
 *  樸素細框線。尺寸在所有名次一致,名次只靠左側指標(王冠/銀銅/數字)
 *  與第一名的金色光暈表示。 */
const GOLD = '#C29A3D'   // 金 — 王冠使用
const LEAD_RING = 'rgba(201,161,74,0.55)'  // 第一名卡片的金色光暈(邊框)
const LEAD_GLOW = 'rgba(201,161,74,0.20)'  // 第一名卡片的金色光暈(模糊)

/** 第 2、3 名號碼圓圈色 = 銀 / 銅。第 4 名以後不上色,退為中性(pale)。 */
const RANK_COLOR: Record<number, string> = {
  2: '#98A2AC',  // 銀
  3: '#B87C4E',  // 銅
}

interface Props {
  wish:          Wish
  isVoted:       boolean
  /** Member who proposed this wish. Missing when member data is still loading
   *  or when the proposer has left the trip. */
  proposer?:     TripMember
  /** Demo mode — dim the heart but keep the click (opens sign-in). */
  isPreviewOnly: boolean
  canEdit:       boolean
  canDelete:     boolean
  onEdit:        () => void
  onDelete:      () => void
  onOpenDetails: () => void
  onToggleVote:  () => void
  /** LCP hint for the lead card's thumbnail (rank 1, above the fold). */
  eager?:        boolean
  /** This wish's write is in flight (page derives it from the overlay). */
  isUpdating?:   boolean
  /** 1-based 名次(依票數降冪)。1 = 第一名 lead(強調),2 以上 = 一般列。 */
  rank:          number
  /** 贊成度的顯示狀態(票數 + 成員數 + ready)。由 WishPage 決定後傳入。 */
  consensus:     Consensus
}

function WishCard({
  wish, isVoted, proposer, isPreviewOnly, canEdit, canDelete,
  onEdit, onDelete, onOpenDetails, onToggleVote, eager, isUpdating, rank, consensus,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isPending = !!isUpdating
  const hasMenu = !isPending && (canEdit || canDelete)
  const tap = !isPending ? onOpenDetails : undefined
  const isLead = rank === 1
  // 名次差異不靠尺寸,而以左側名次指示器(王冠/銀銅/數字)+ 第一名的金光
  // 表示。縮圖/字體/條/按鈕在所有名次一致(第 4 名以後也同尺寸)。
  // 第一名的王冠 + 金色光暈只在「真的領先」時顯示(沒人投票時
  // 只是排在最前)。pending 期間名次不一定確定,所以不顯示。
  const showCrown = isLead && !isPending && wish.votes.length > 0
  // 載入時的 staggered reveal:rank 越後面延遲越多(上限 350ms)。
  const revealDelay = Math.min((rank - 1) * 50, 350)
  // 縮圖尺寸在所有名次相同(56)。
  const thumbSizeCls  = 'w-14 h-14'
  const thumbIconSize = 22

  return (
    <article
      className={[
        'relative bg-surface overflow-hidden animate-wish-reveal rounded-[18px]',
        // 只有第一名有金色光暈(下方 boxShadow 兼作 ring);其他為無色細框線。
        showCrown ? '' : 'ring-1 ring-black/[0.06]',
      ].join(' ')}
      style={{
        animationDelay: `${revealDelay}ms`,
        ...(showCrown ? { boxShadow: `0 0 0 1.5px ${LEAD_RING}, 0 3px 16px ${LEAD_GLOW}` } : {}),
      }}
    >
      {/* 整卡 tap-to-detail。stretched overlay button:把覆蓋整張卡片的
          透明按鈕鋪在子元素「下方」(z-0)。z-0 的絕對定位會畫在一般流的
          內容之上(= 接住文字/縮圖的點擊),但操作元素以
          relative z-10 再浮到更上層,所以投票/⋮ 不會被穿透。藉此
          避免巢狀 button,同時做到「點卡片任何地方都進詳細」。
          pending 期間 tap=undefined,所以不會出現 button。 */}
      {tap && (
        <button
          type="button"
          onClick={tap}
          aria-label={`查看 ${wish.title} 的詳細資料`}
          className="absolute inset-0 z-0 w-full bg-transparent border-none p-0 cursor-pointer"
        />
      )}
      {hasMenu && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
          aria-label="其他操作"
          className="absolute top-1 right-2 z-10 w-8 h-8 rounded-full text-muted hover:bg-app flex items-center justify-center border-none bg-transparent cursor-pointer transition-colors"
        >
          <MoreVertical size={16} strokeWidth={2.2} />
        </button>
      )}

      <div className={['grid grid-cols-[20px_56px_minmax(0,1fr)] items-center gap-2.5 p-2.5 pr-2 transition-opacity', isPending ? 'opacity-55' : ''].join(' ')}>
        {/* 名次指示器 — pending 期間名次不一定確定,所以只隱藏內容
            (保留同寬 placeholder,temp→正式 row 時不會橫向跳動)。 */}
        <RankIndicator rank={rank} showCrown={showCrown} pending={isPending} />
        {/* 縮圖。不做成外部連結,交給整張卡片的詳細點擊。 */}
        <div className="relative w-14 h-14 shrink-0">
          <WishThumb
            wish={wish}
            sizeCls={thumbSizeCls}
            iconSize={thumbIconSize}
            eager={eager}
          />
          <ProposerAvatar proposer={proposer} />
        </div>

        <div className="min-w-0 flex flex-col gap-2">
          {/* 標題列。卡片負責詳細,右上負責管理,下段負責投票,分工明確。 */}
          <div className={['truncate text-ink -tracking-[0.2px] text-[13.5px] font-black leading-[1.15]', hasMenu ? 'pr-8' : ''].join(' ')}>
            {wish.title}
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <div className="min-w-0 flex-1">
              <WishConsensusBar consensus={consensus} size="sm" delay={revealDelay + 120} />
            </div>
            <div className="relative z-10 shrink-0">
              <WishVoteButton
                isVoted={isVoted}
                isPreviewOnly={isPreviewOnly || isPending}
                disabled={isPending}
                onToggleVote={onToggleVote}
                variant="pill"
              />
            </div>
          </div>
        </div>
      </div>

      {isPending && <PendingPill />}
      {/* Portaled: the article is transformed (reveal animation) and
          overflow-hidden, which would make it the fixed sheet's containing
          block and clip it while the animation runs. */}
      {menuOpen && createPortal(
        <WishActionMenu
          isOpen
          wish={wish}
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={onEdit}
          onDelete={onDelete}
          onClose={() => setMenuOpen(false)}
        />,
        document.body,
      )}
    </article>
  )
}

// ─── 共用子元件 ────────────────────────────────────────

/** 卡片左側的名次指示器。第一名(showCrown)= 金色王冠,第 2、3 名 = 銀/銅
 *  實心號碼圓圈(白色數字),第 4 名以後 = 中性 pale 圓圈(muted 數字)。
 *  尺寸不隨名次變化(名次差異以顏色/王冠表示,不以尺寸表示)。 */
function RankIndicator({ rank, showCrown, pending }: { rank: number; showCrown: boolean; pending?: boolean }) {
  const medalColor = RANK_COLOR[rank]
  // pending 期間名次未確定。只保留同寬的框、內容留空(維持版面)。
  if (pending) return <div className="shrink-0 w-5" aria-hidden />
  return (
    <div className="shrink-0 w-5 flex items-center justify-center" aria-label={`第 ${rank} 名`}>
      {showCrown ? (
        <Crown size={18} strokeWidth={2.2} style={{ color: GOLD }} fill="rgba(194,154,61,0.25)" />
      ) : (
        <span
          className={[
            'w-5 h-5 rounded-full text-[10.5px] font-black flex items-center justify-center tabular-nums',
            medalColor ? 'text-white' : 'bg-app text-muted',
          ].join(' ')}
          style={medalColor ? { background: medalColor } : undefined}
        >
          {rank}
        </span>
      )}
    </div>
  )
}

/** 列的縮圖(正方形)。不做成外部連結,點擊由卡片詳細吸收。 */
function WishThumb({
  wish, sizeCls, iconSize, eager,
}: {
  wish: Wish; sizeCls: string; iconSize: number; eager?: boolean
}) {
  const thumbUrl = useAttachmentUrl(wish.image?.thumbPath, { kind: 'thumb' })
  const CategoryIcon = WISH_CATEGORY_ICON[wish.category]

  const visual = wish.image && thumbUrl ? (
    <img
      src={thumbUrl}
      alt=""
      decoding="async"
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : undefined}
      draggable={false}
      className="absolute inset-0 w-full h-full object-cover"
    />
  ) : (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{ background: CATEGORY_GRADIENT[wish.category] }}
      aria-hidden
    >
      <CategoryIcon size={iconSize} strokeWidth={1.8} color={CATEGORY_ICON_COLOR[wish.category]} />
    </div>
  )

  const boxCls = ['relative rounded-[14px] overflow-hidden shrink-0 bg-tile', sizeCls].join(' ')
  return <div className={[boxCls, 'pointer-events-none'].join(' ')}>{visual}</div>
}

/** pending(保存中…)pill — 右上。 */
function PendingPill() {
  return (
    <div className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 text-white text-[10.5px] font-semibold backdrop-blur-sm">
      <PendingIndicator size={11} strokeWidth={2.4} />
    </div>
  )
}

/** 提案者頭像。列表的 avatar 表示「誰提案的」而不是「投票者」。
 *  投票者名單集中在 detail sheet。 */
function ProposerAvatar({ proposer }: { proposer?: TripMember }) {
  if (!proposer) return null
  return (
    <span
      role="img"
      title={`提案者：${proposer.displayName}`}
      aria-label={`提案者：${proposer.displayName}`}
      className="pointer-events-none absolute -bottom-1 left-1/2 -translate-x-1/2 inline-flex rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.10)]"
      style={{ isolation: 'isolate' }}
    >
      <MemberAvatar
        member={proposer}
        size={20}
        className="border-[1.5px] border-surface text-[8.5px]"
        style={AVATAR_LAYER_STYLE}
      />
    </span>
  )
}

// React Compiler auto-memoises — no manual React.memo needed.
export default WishCard
