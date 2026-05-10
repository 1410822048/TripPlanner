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
import { memo } from 'react'
import { Heart, Map, ExternalLink, Trash2 } from 'lucide-react'
import type { Wish } from '@/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'
import ActionChip from '@/components/ui/ActionChip'
import { mapsSearchUrl } from '@/utils/maps'

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
  wish, isVoted, isPreviewOnly,
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
  isPreviewOnly:  boolean
  onTap:          (e: React.MouseEvent) => void
  onToggleVote:   (e: React.MouseEvent) => void
}

function CardContent({ wish, isVoted, isPreviewOnly, onTap, onToggleVote }: ContentProps) {
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
  wish, isVoted, isPreviewOnly, onToggleVote,
}: {
  wish:          Wish
  isVoted:       boolean
  isPreviewOnly: boolean
  onToggleVote:  (e: React.MouseEvent) => void
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1.5">
      {wish.address && <MapChip query={wish.address} />}
      {wish.link    && <LinkChip url={wish.link} hasAddress={!!wish.address} />}
      <button
        onClick={onToggleVote}
        aria-label={isVoted ? '投票を取り消す' : '投票する'}
        aria-pressed={isVoted}
        className={[
          'ml-auto flex items-center gap-1 h-8 px-2.5 rounded-full border bg-surface cursor-pointer transition-all active:scale-[0.97]',
          isVoted
            ? 'border-[#E04B5E] bg-[#FFF2F4]'
            : 'border-border hover:bg-app',
          isPreviewOnly ? 'opacity-60' : '',
        ].join(' ')}
      >
        <Heart
          size={14}
          strokeWidth={2.2}
          className={isVoted ? 'text-[#E04B5E]' : 'text-muted'}
          fill={isVoted ? '#E04B5E' : 'none'}
        />
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

export default memo(WishCard, (prev, next) => (
  prev.wish === next.wish &&
  prev.isVoted === next.isVoted &&
  prev.isPreviewOnly === next.isPreviewOnly &&
  prev.isOpen === next.isOpen
))
