// src/features/wish/components/WishCard.tsx
// Pinterest-style card for the Wish list. The wish list is inspiration-
// driven (places I want to visit, food I want to try) — not archival,
// so the layout leans heavily on the cover image. When no image, a
// category-tinted gradient + large emoji keeps the hero region from
// feeling empty.
//
// Card anatomy:
//   - 16:9 hero region (image cover OR emoji + gradient)
//   - Body: title + optional description (clamped 2 lines)
//   - Action row: 🗺/🔗 chip + heart vote
//
// Tap-to-edit and swipe-to-delete remain identical to the previous row
// version; the inner action chips stopPropagation so they don't also
// trigger the row's primary tap.
//
// Two map / link affordances:
//   - `address` (free-form) → dedicated 🗺 chip pointing at
//     google.com/maps/search/?query={address}. Set explicitly on the
//     wish; this is the canonical map source going forward.
//   - `link` → 🔗 サイト chip for the official URL. When `address`
//     is empty we keep a legacy auto-detect so a Maps URL pasted into
//     `link` still surfaces as 🗺 (the original Phase 1 behaviour);
//     once `address` is set, the link always renders as サイト so the
//     two chips don't both claim the map role.
import { useState } from 'react'
import { Heart, Map, ExternalLink, Trash2 } from 'lucide-react'
import type { Wish } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'
import ActionChip from '@/components/ui/ActionChip'
import MemberAvatar from '@/components/ui/MemberAvatar'
import { mapsSearchUrl } from '@/utils/maps'
import { haptic } from '@/utils/haptics'

const MAX_AVATARS = 3

/** Voter chip style 對策 iOS Safari PWA 在 translate3d 父層下的殘影
 *  bug:子層 mount/unmount 時,Safari 偶爾把 shadow + border 緩存進
 *  父層 raster 沒重畫,留下空心圓殘影。
 *
 *  雙保險:
 *   1. position: relative → 讓 zIndex 生效,並確立 chip 在 isolated
 *      context 內的層級
 *   2. translateZ(0) → promote 到獨立 GPU compositing layer,React
 *      unmount 時整個 layer 一起丟,Safari 不會跟父層混淆
 *
 *  WebkitTransform prefix 不需要 — Safari 9+ 起 transform 就是標準名
 *  稱,專案目標環境(React 19 PWA)遠在那之後。 */
const AVATAR_LAYER_STYLE: React.CSSProperties = {
  position:  'relative',
  transform: 'translateZ(0)',
}

const CATEGORY_EMOJI: Record<Wish['category'], string> = {
  place: '🗺️',
  food:  '🍜',
}

/** Hero gradient when no image is uploaded — distinct per category so
 *  empty-state cards still feel intentional rather than blank. */
const CATEGORY_GRADIENT: Record<Wish['category'], string> = {
  place: 'linear-gradient(135deg, #d4ecf6 0%, #8fb8d6 100%)',
  food:  'linear-gradient(135deg, #fde2cc 0%, #f0a87a 100%)',
}

/** Detect Google Maps URLs so the chip can surface a more meaningful
 *  「地図」 label instead of generic 「サイト」. Covers the four common
 *  shapes: web maps URL, mobile app deep links (maps.app.goo.gl /
 *  goo.gl/maps), and the legacy maps.google.com host. */
function isMapsLink(url: string): boolean {
  const u = url.toLowerCase()
  return u.includes('google.com/maps')
    || u.includes('maps.app.goo.gl')
    || u.includes('goo.gl/maps')
    || u.includes('maps.google')
}

interface Props {
  wish:        Wish
  isVoted:     boolean
  /** Voters who have hearted this wish, in `wish.votes[]` order
   *  (= first-voted first). Parent resolves uids → TripMember so we
   *  don't have to hold a member lookup here. Unknown uids (e.g. former
   *  members) are simply omitted by the parent; the heart count still
   *  reflects `wish.votes.length` for honesty. */
  voters:        TripMember[]
  /** True in demo mode — visually dim the heart so users sense it's
   *  "not real yet", but the click still fires so the parent can
   *  surface the sign-in prompt. */
  isPreviewOnly: boolean
  /** Swipe-state controlled by parent (useSwipeOpen). Optional —
   *  callers without delete permission omit these and the card renders
   *  without swipe affordance. */
  isOpen?:  boolean
  onOpen?:  () => void
  onClose?: () => void
  onDelete?:    () => void
  onTap:        () => void
  onToggleVote: () => void
}

function WishCard({
  wish, isVoted, voters, isPreviewOnly,
  isOpen, onOpen, onClose, onDelete,
  onTap, onToggleVote,
}: Props) {
  const swipeable = !!onDelete && !!onOpen && !!onClose
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen: !!isOpen, onOpen, onClose, onDelete, enabled: swipeable })

  const cardBody = <CardContent
    wish={wish}
    isVoted={isVoted}
    voters={voters}
    isPreviewOnly={isPreviewOnly}
    onTap={wrapTap(onTap)}
    onToggleVote={wrapTap(onToggleVote)}
  />

  if (!swipeable) {
    return (
      <div className="bg-surface border border-border rounded-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.06)] overflow-hidden">
        {cardBody}
      </div>
    )
  }

  return (
    <div className="relative rounded-[18px] overflow-hidden bg-surface border border-border shadow-[0_2px_10px_rgba(0,0,0,0.06)]">
      <div
        ref={bindBg}
        {...deleteProps}
        className={[
          'absolute top-0 right-0 bottom-0 flex items-center justify-center cursor-pointer',
          confirming ? 'bg-[#A83A3A]' : 'bg-[#D85A5A]',
        ].join(' ')}
        style={{
          width: SWIPE_WIDTH,
          transform: `translate3d(${SWIPE_WIDTH + openX}px,0,0)`,
          transition: BG_TRANSITION,
          pointerEvents: openX < 0 ? 'auto' : 'none',
        }}
      >
        {confirming ? (
          <div className="text-white text-[11px] font-bold tracking-[0.04em] text-center leading-[1.3]">
            確認<br/>削除
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5">
            <Trash2 size={18} color="white" strokeWidth={2.2} />
            <span className="text-white text-[10px] font-bold tracking-[0.04em]">
              削除
            </span>
          </div>
        )}
      </div>

      <div
        ref={bindFg}
        {...pointerProps}
        className="relative select-none bg-surface"
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {cardBody}
      </div>
    </div>
  )
}

// ─── Inner content ────────────────────────────────────────────────
// Split so the swipeable / non-swipeable wrappers stay terse and the
// card layout itself reads as a single coherent piece.

interface ContentProps {
  wish:           Wish
  isVoted:        boolean
  voters:         TripMember[]
  isPreviewOnly:  boolean
  onTap:          (e: React.MouseEvent) => void
  onToggleVote:   (e: React.MouseEvent) => void
}

function CardContent({ wish, isVoted, voters, isPreviewOnly, onTap, onToggleVote }: ContentProps) {
  return (
    // The card's tap-to-edit target is the whole card *body* — but we
    // can't put it on the outer div because action chips inside need to
    // intercept their own clicks. Solution: a clickable region for the
    // hero + body, and the action row below sits OUTSIDE that region so
    // its buttons fire freely. stopPropagation in each chip then keeps
    // the row tap-handler from also firing.
    <>
      <button
        onClick={onTap}
        className="block w-full bg-transparent border-none p-0 text-left cursor-pointer"
      >
        <WishHero wish={wish} />
        <WishBody wish={wish} />
      </button>
      <WishActionRow
        wish={wish}
        isVoted={isVoted}
        voters={voters}
        isPreviewOnly={isPreviewOnly}
        onToggleVote={onToggleVote}
      />
    </>
  )
}

function WishHero({ wish }: { wish: Wish }) {
  // 16:9 ratio keeps the card from getting too tall on phones while
  // leaving plenty of room for a meaningful image. Native CSS
  // aspect-ratio is supported in every browser we target.
  if (wish.image) {
    return (
      <div className="relative w-full aspect-[16/9] bg-tile pointer-events-none">
        <img
          src={wish.image.thumbUrl}
          alt=""
          decoding="async"
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
        />
      </div>
    )
  }
  return (
    <div
      className="w-full aspect-[16/9] flex items-center justify-center text-[64px] pointer-events-none"
      style={{ background: CATEGORY_GRADIENT[wish.category] }}
      aria-hidden
    >
      {CATEGORY_EMOJI[wish.category]}
    </div>
  )
}

function WishBody({ wish }: { wish: Wish }) {
  return (
    <div className="px-3.5 pt-2.5 pb-1 pointer-events-none">
      <div className="text-[14px] font-bold text-ink -tracking-[0.2px] truncate">
        {wish.title}
      </div>
      {wish.description && (
        <div className="text-[11.5px] text-muted mt-0.5 line-clamp-2 leading-[1.45]">
          {wish.description}
        </div>
      )}
    </div>
  )
}

function WishActionRow({
  wish, isVoted, voters, isPreviewOnly, onToggleVote,
}: {
  wish:          Wish
  isVoted:       boolean
  voters:        TripMember[]
  isPreviewOnly: boolean
  onToggleVote:  (e: React.MouseEvent) => void
}) {
  // 「投票按下後的 pop 動畫」獨立 state — 點擊瞬間就觸發,不等
  // mutation,因為視覺回饋必須在 100ms 內出現才有感。onAnimationEnd
  // 自動 cleanup,點越快動畫越會接連觸發(每次 setState 都重啟 animation
  // class 的 mount cycle)。
  const [pulsing, setPulsing] = useState(false)

  function handleClick(e: React.MouseEvent) {
    // demo 模式只是開 sign-in modal,沒實際投票 — 跳過 celebration
    // 以免「投了沒效果但有動畫」的錯覺。
    if (!isPreviewOnly) {
      haptic('light')
      setPulsing(true)
    }
    onToggleVote(e)
  }

  return (
    <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1.5">
      {wish.address && <MapChip query={wish.address} />}
      {wish.link    && <LinkChip url={wish.link} hasAddress={!!wish.address} />}
      <VoterStack voters={voters} totalVotes={wish.votes.length} />
      <button
        onClick={handleClick}
        aria-label={isVoted ? '投票を取り消す' : '投票する'}
        aria-pressed={isVoted}
        className={[
          'flex items-center gap-1 h-8 px-2.5 rounded-full border bg-surface cursor-pointer transition-all active:scale-[0.97]',
          voters.length === 0 ? 'ml-auto' : '',
          isVoted
            ? 'border-[#E04B5E] bg-[#FFF2F4]'
            : 'border-border hover:bg-app',
          isPreviewOnly ? 'opacity-60' : '',
        ].join(' ')}
      >
        <span
          className={pulsing ? 'animate-heart-pop inline-flex' : 'inline-flex'}
          onAnimationEnd={() => setPulsing(false)}
        >
          <Heart
            size={14}
            strokeWidth={2.2}
            className={isVoted ? 'text-[#E04B5E]' : 'text-muted'}
            fill={isVoted ? '#E04B5E' : 'none'}
          />
        </span>
        <span className={[
          'text-[11.5px] font-bold tabular-nums',
          isVoted ? 'text-[#E04B5E]' : 'text-muted',
        ].join(' ')}>
          {wish.votes.length}
        </span>
      </button>
    </div>
  )
}

/** Stacked voter avatars — first MAX_AVATARS shown overlapping, rest
 *  collapsed into a "+N" chip. ml-auto pushes the whole group to the
 *  right so the heart button stays at the row end.
 *
 *  Why purely visual (not a button):
 *    - The heart already carries the "vote" affordance.
 *    - A "see all voters" popover adds cognitive load for a feature
 *      that has at most ~6 members per trip — the stacked avatars
 *      themselves already convey "who" at a glance.
 *
 *  totalVotes is passed separately so the +N math reflects the source
 *  of truth (`wish.votes.length`) even when some voters were dropped
 *  upstream (e.g. uid not in current members). The avatars show "who
 *  we know voted"; the heart count + "+N" cover everyone else. */
function VoterStack({ voters, totalVotes }: { voters: TripMember[]; totalVotes: number }) {
  if (voters.length === 0) return null
  const shown   = voters.slice(0, MAX_AVATARS)
  const overflow = totalVotes - shown.length
  return (
    // `isolation: isolate` 建立獨立的 stacking context,把 chip 的
    // mount/unmount 鎖在這個 subtree 內。配合 AVATAR_LAYER_STYLE 上的
    // translateZ(0),為 iOS Safari PWA 修正取消投票後 voter chip
    // 殘影空心圓的 bug。
    //
    // 移除 box-shadow:shadow 是 GPU raster cache 殘影的最大主因,
    // border-surface 的白邊已足以區隔 chip 與背景。視覺差異微乎其
    // 微(原本只是 8% 不透明的 1px 微陰影),換來最穩定的 cleanup。
    <div className="ml-auto flex items-center mr-1" style={{ isolation: 'isolate' }}>
      {shown.map((m, i) => (
        <MemberAvatar
          key={m.id}
          member={m}
          size={20}
          className="border-[1.5px] border-surface text-[9.5px]"
          style={{
            ...AVATAR_LAYER_STYLE,
            marginLeft: i === 0 ? 0 : -6,
            zIndex:     shown.length - i,
          }}
        />
      ))}
      {overflow > 0 && (
        <span
          className="w-[20px] h-[20px] rounded-full flex items-center justify-center text-[9px] font-bold border-[1.5px] border-surface bg-app text-muted tabular-nums"
          style={{ ...AVATAR_LAYER_STYLE, marginLeft: -6 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

/** Smart "open link" chip — reads the link URL to decide whether the
 *  user's heading to a map (geographic intent) or a generic site, and
 *  swaps icon + label.
 *
 *  Implemented as `<a target="_blank">` (not `<button>` + window.open)
 *  for two iOS-PWA-specific reasons:
 *  1. In iOS standalone mode, `window.open(url, '_blank')` navigates
 *     the PWA's own view (there is no "tab" concept) — when the user
 *     returns from Google Maps the PWA looks stuck mid-navigation.
 *     `<a target="_blank">` triggers Safari's external-link handler
 *     which keeps our view untouched.
 *  2. iOS Universal Links route google.com/maps anchor clicks straight
 *     into the native Maps app when installed, without bouncing
 *     through Safari at all — better deep-link UX.
 *
 *  stopPropagation in both onClick and onPointerDown still required so
 *  the parent card-body button doesn't also fire its tap-to-edit, and
 *  the swipe gesture doesn't arm when the user reaches for the chip. */
function LinkChip({ url, hasAddress }: { url: string; hasAddress: boolean }) {
  // When `address` is set, the dedicated map chip already covers the
  // map role — collapse this chip to plain サイト so both chips don't
  // claim 地図.
  const isMaps = !hasAddress && isMapsLink(url)
  return (
    <ActionChip
      href={url}
      icon={isMaps ? Map : ExternalLink}
      label={isMaps ? '地図' : 'サイト'}
      ariaLabel={isMaps ? '地図で開く' : 'リンクを開く'}
    />
  )
}

/** Address-driven map chip. Reuses ActionChip + the shared mapsSearchUrl
 *  builder — kept as a thin wrapper so call sites read as a single
 *  intent rather than re-deriving the URL inline. */
function MapChip({ query }: { query: string }) {
  const href = mapsSearchUrl(query)
  if (!href) return null
  return <ActionChip href={href} icon={Map} label="地図" ariaLabel="地図で開く" />
}

// React Compiler auto-memoises the component; manual React.memo + custom
// propsAreEqual is now redundant.
export default WishCard
