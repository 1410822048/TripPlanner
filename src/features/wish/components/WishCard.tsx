// src/features/wish/components/WishCard.tsx
// 投票ボード(consensus leaderboard)の候補カード。Wish は「みんなで行き先を
// 決める」投票システムなので、レイアウトは順位・賛成度・投票アクションを主役に
// する(以前の Pinterest 風 image grid からの転換)。
//
// 単一の row レイアウト。サイズは全順位で統一(サムネ 56 / 賛成度バー / pill
// 投票ボタン)。順位は寸法ではなく「左の順位インジケータ(本命 = 金の王冠、
// 2・3 位 = 銀/銅の数字サークル、4 位以下 = 中立の数字)+ 本命のみカードに金
// グロー」で示す。縦の並び順がそのまま順位。WishPage が 3 位と 4 位の間に候補
// ラインを挿す。
//
// 賛成度 = votes.length / memberCount。approval voting(各自が複数に賛成できる)
// なので「絶対票数」より「メンバーの何人が行きたいか」が意味のある指標。
//
// インタラクション規約:
//   - tap-to-detail は「カード全体」。カード全面を覆う透明 button を子要素の
//     「下」(z-0)に敷き、操作要素(投票 / ⋮)だけ
//     z-10 で上に出す stretched-overlay パターン(ネスト button 回避)。
//   - 地図/網站などの外部アクションは detail sheet に集約。カードは比較・投票・
//     詳細への入口だけを持ち、誤タップで外部遷移しない。
//   - ⋮ メニューが edit/delete の唯一の入口、pending(temp- / isUpdating)中は
//     tap・投票・swipe を無効化して 保存中… を出す。
import { useState } from 'react'
import { MoreVertical, Loader2, Crown } from 'lucide-react'
import type { Wish } from '@/types'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
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

/** グラデーション上のアイコン色 — 各分類の深いトーンでコントラストを確保。 */
const CATEGORY_ICON_COLOR: Record<Wish['category'], string> = {
  place: '#33617f',
  food:  '#b5652e',
}

/** 順位インジケータはカード左の gutter に出す(サムネ角の番号バッジではない):
 *  本命(rank 1)= 金の王冠 + カードに金グロー、それ以外 = 中立の番号サークル +
 *  プレーンなヘアライン。サイズは全順位で揃え、順位は左の指標(王冠/銀銅/数字)
 *  と本命の金グローだけで示す。 */
const GOLD = '#C29A3D'   // 金 — 王冠で使用
const LEAD_RING = 'rgba(201,161,74,0.55)'  // 本命カードの金グロー(縁)
const LEAD_GLOW = 'rgba(201,161,74,0.20)'  // 本命カードの金グロー(ぼかし)

/** 2・3 位の番号サークル色 = 銀 / 銅。4 位以下は色を付けず中立(pale)に落とす。 */
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
  /** This wish's UPDATE is in-flight (page derives via usePendingMutationIds). */
  isUpdating?:   boolean
  /** 1-based 順位(投票数の降順)。1 = 本命 lead(強調)、2 以上 = 通常行。 */
  rank:          number
  /** 賛成度の表示状態(票数 + メンバー数 + ready)。WishPage が確定して渡す。 */
  consensus:     Consensus
}

function WishCard({
  wish, isVoted, proposer, isPreviewOnly, canEdit, canDelete,
  onEdit, onDelete, onOpenDetails, onToggleVote, eager, isUpdating, rank, consensus,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isPending = wish.id.startsWith('temp-') || !!isUpdating
  const hasMenu = !isPending && (canEdit || canDelete)
  const tap = !isPending ? onOpenDetails : undefined
  const isLead = rank === 1
  // 順位差はサイズではなく左の順位インジケータ(王冠/銀銅/数字)+ 本命の金光で
  // 示す。サムネ/フォント/バー/ボタンは全順位で揃える(4 位以下も同寸)。
  // 本命の王冠 + 金グローは「実際にリードしている」時だけ(誰も投票してなければ
  // 単なる先頭)。pending 中は順位が確定とは限らないので出さない。
  const showCrown = isLead && !isPending && wish.votes.length > 0
  // 載入時の staggered reveal:rank が下がるほど少し遅らせる(上限 350ms)。
  const revealDelay = Math.min((rank - 1) * 50, 350)
  // サムネ寸法は全順位で同寸(56)。
  const thumbSizeCls  = 'w-14 h-14'
  const thumbIconSize = 22

  return (
    <article
      className={[
        'relative bg-surface overflow-hidden animate-wish-reveal rounded-[18px]',
        // 本命のみ金グロー(下の boxShadow が ring を兼ねる);他は無色ヘアライン。
        showCrown ? '' : 'ring-1 ring-black/[0.06]',
      ].join(' ')}
      style={{
        animationDelay: `${revealDelay}ms`,
        ...(showCrown ? { boxShadow: `0 0 0 1.5px ${LEAD_RING}, 0 3px 16px ${LEAD_GLOW}` } : {}),
      }}
    >
      {/* 整卡 tap-to-detail。stretched overlay button:カード全体を
          覆う透明ボタンを子要素の「下」(z-0)に敷く。z-0 の絶対配置は通常フローの
          中身より上に描画される(= テキスト/サムネのタップを拾う)が、操作要素は
          relative z-10 でさらに上に出すので投票/⋮ は素通りしない。これで
          ネスト button を避けつつ「カードのどこを押しても詳細」を実現する。
          pending 中は tap=undefined なので button は出ない。 */}
      {tap && (
        <button
          type="button"
          onClick={tap}
          aria-label={`${wish.title}の詳細を見る`}
          className="absolute inset-0 z-0 w-full bg-transparent border-none p-0 cursor-pointer"
        />
      )}
      {hasMenu && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
          aria-label="その他の操作"
          className="absolute top-1 right-2 z-10 w-8 h-8 rounded-full text-muted hover:bg-app flex items-center justify-center border-none bg-transparent cursor-pointer transition-colors"
        >
          <MoreVertical size={16} strokeWidth={2.2} />
        </button>
      )}

      <div className={['grid grid-cols-[20px_56px_minmax(0,1fr)] items-center gap-2.5 p-2.5 pr-2 transition-opacity', isPending ? 'opacity-55' : ''].join(' ')}>
        {/* 順位インジケータ — pending 中は順位が確定とは限らないので中身だけ隠す
            (同幅の placeholder は残し、temp→正式 row で横方向にジャンプさせない)。 */}
        <RankIndicator rank={rank} showCrown={showCrown} pending={isPending} />
        {/* サムネ。外部リンクにはせず、カード全体の詳細タップに通す。 */}
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
          {/* タイトル行。カードは詳細、右上は管理、下段は投票に役割を分ける。 */}
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
      {menuOpen && (
        <WishActionMenu
          isOpen
          wish={wish}
          canEdit={canEdit}
          canDelete={canDelete}
          onEdit={onEdit}
          onDelete={onDelete}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </article>
  )
}

// ─── 共有サブコンポーネント ────────────────────────────────────────

/** カード左の順位インジケータ。本命(showCrown)= 金の王冠、2・3 位 = 銀/銅の
 *  ソリッド番号サークル(白数字)、4 位以下 = 中立の pale サークル(muted 数字)。
 *  サイズは順位に依らず一定(順位差は色/王冠で示し、寸法では示さない)。 */
function RankIndicator({ rank, showCrown, pending }: { rank: number; showCrown: boolean; pending?: boolean }) {
  const medalColor = RANK_COLOR[rank]
  // pending 中は順位未確定。同幅の枠だけ残して中身を空にする(レイアウト維持)。
  if (pending) return <div className="shrink-0 w-5" aria-hidden />
  return (
    <div className="shrink-0 w-5 flex items-center justify-center" aria-label={`${rank}位`}>
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

/** 行のサムネ(正方形)。外部リンク化せず、タップはカード詳細に吸収させる。 */
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
      <Loader2 size={11} strokeWidth={2.4} className="animate-spin" />
      <span>保存中…</span>
    </div>
  )
}

/** 提案者頭像。リストの avatar は「投票者」ではなく「誰が提案したか」を示す。
 *  投票者一覧は detail sheet に集約する。 */
function ProposerAvatar({ proposer }: { proposer?: TripMember }) {
  if (!proposer) return null
  return (
    <span
      role="img"
      title={`提案者: ${proposer.label}`}
      aria-label={`提案者: ${proposer.label}`}
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
