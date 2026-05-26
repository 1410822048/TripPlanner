// src/features/wish/components/WishCard.tsx
// Pinterest-style card for the Wish list. Wish list is inspiration-driven
// (places I want to visit, food I want to try) — not archival — so the
// layout leans heavily on the cover image. When no image, a category-
// tinted gradient + large emoji keeps the hero region from feeling empty.
//
// Card anatomy:
//   - 16:9 hero region (image cover OR emoji + gradient) with overflow ⋮
//     button overlaid at top-right when the viewer has actions available
//   - Body: title + optional description (clamped 2 lines)
//   - Action row: 🗺/🔗 chips + voter stack + heart vote
//
// Tap-to-edit fires only when `canEdit` (proposer). For non-proposer
// viewers the card body is read-only — no cursor, no tap. The ⋮ menu
// is the sole entry to actions (edit / delete), gated per role to
// mirror firestore.rules. Overflow-menu (not swipe) follows the card-
// pattern convention (Pinterest / Instagram / Tumblr) — swipe is for
// list rows, where the gesture's discoverability cost is acceptable.
//
// Two map / link affordances:
//   - `address` (free-form) → dedicated 🗺 chip pointing at
//     google.com/maps/search/?query={address}. Canonical map source.
//   - `link` → 🔗 サイト chip for the official URL. When `address` is
//     empty, falls back to auto-detecting Maps URLs and surfaces them
//     as 🗺 (legacy behaviour); once `address` is set, link is always
//     サイト so the two chips don't both claim the map role.
import { useState } from 'react'
import { Heart, Map, ExternalLink, MoreVertical, Loader2 } from 'lucide-react'
import type { Wish } from '@/types'
import type { TripMember } from '@/features/trips/types'
import ActionChip from '@/components/ui/ActionChip'
import MemberAvatar from '@/components/ui/MemberAvatar'
import WishActionMenu from './WishActionMenu'
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
 *      unmount 時整個 layer 一起丟,Safari 不會跟父層混淆 */
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
  wish:          Wish
  isVoted:       boolean
  /** Voters who have hearted this wish, in `wish.votes[]` order (=
   *  first-voted first). Parent resolves uids → TripMember so we don't
   *  hold a member lookup here. Unknown uids (former members) are
   *  omitted upstream; the heart count still reflects votes.length so
   *  they show up as "+N" rather than vanishing. */
  voters:        TripMember[]
  /** True in demo mode — visually dim the heart so users sense it's
   *  "not real yet", but the click still fires so the parent can
   *  surface the sign-in prompt. */
  isPreviewOnly: boolean
  /** Whether the viewer can edit (proposer-only in cloud mode; true in
   *  demo so the signIn prompt is reachable). Drives card-body tap +
   *  menu "編集" item visibility. */
  canEdit:       boolean
  /** Whether the viewer can delete (proposer or trip owner). Drives the
   *  menu "削除" item visibility. */
  canDelete:     boolean
  onEdit:        () => void
  onDelete:      () => void
  onToggleVote:  () => void
  /** Caller-asserted "this card's image is a likely LCP candidate"
   *  (typically the first visible card on /wish). Suppresses the
   *  default `loading="lazy"` on the hero <img> so the browser
   *  discovers the request during initial parse instead of after
   *  layout — lazy loading the first card image was measurably
   *  delaying LCP. Defaults to false → all subsequent cards stay
   *  lazy. */
  eager?:        boolean
}

function WishCard({
  wish, isVoted, voters, isPreviewOnly,
  canEdit, canDelete, onEdit, onDelete, onToggleVote, eager,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Optimistic-create temp row: disable tap-to-edit, hide ⋮ menu, dim
  // the body, and show a 保存中… pill at top-right. Vote button is
  // disabled inside WishActionRow to stop voting on a non-existent doc.
  const isPending = wish.id.startsWith('temp-')

  const hasMenu = !isPending && (canEdit || canDelete)
  // Card body tap-to-edit only when the viewer can actually edit AND
  // the row isn't pending. Read-only viewers / pending rows see no
  // cursor / no tap feedback.
  const tap = !isPending && canEdit ? onEdit : undefined

  const heroBody = (
    <>
      <WishHero wish={wish} eager={eager} />
      <WishBody wish={wish} />
    </>
  )

  return (
    <div className="relative bg-surface border border-border rounded-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className={['transition-opacity', isPending ? 'opacity-55' : ''].join(' ')}>
        {tap ? (
          <button
            type="button"
            onClick={tap}
            className="block w-full bg-transparent border-none p-0 text-left cursor-pointer"
          >
            {heroBody}
          </button>
        ) : (
          heroBody
        )}

        <WishActionRow
          wish={wish}
          isVoted={isVoted}
          voters={voters}
          isPreviewOnly={isPreviewOnly || isPending}
          onToggleVote={isPending ? () => {} : onToggleVote}
        />
      </div>

      {hasMenu && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(true) }}
          aria-label="その他の操作"
          // Visual is 32×32 (w-8 h-8) — looks balanced on the card.
          // Hit area extended to 44×44 via the ::before pseudo-element
          // (-inset-1.5 = 6px on every side) so the touch target meets
          // iOS HIG / Material's min spec without an oversized disc.
          // active: handles touch-down feedback (mobile has no hover).
          className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/40 text-white flex items-center justify-center border-none cursor-pointer transition-colors active:bg-black/60 before:content-[''] before:absolute before:-inset-1.5"
          style={{ backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
        >
          <MoreVertical size={16} strokeWidth={2.4} />
        </button>
      )}

      {isPending && (
        <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 text-white text-[10.5px] font-semibold backdrop-blur-sm">
          <Loader2 size={11} strokeWidth={2.4} className="animate-spin" />
          <span>保存中…</span>
        </div>
      )}

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
    </div>
  )
}

// ─── Hero + body sub-components ──────────────────────────────────

function WishHero({ wish, eager }: { wish: Wish; eager?: boolean }) {
  // 16:9 ratio keeps the card from getting too tall on phones while
  // leaving plenty of room for a meaningful image.
  if (wish.image) {
    return (
      <div className="relative w-full aspect-[16/9] bg-tile pointer-events-none">
        <img
          src={wish.image.thumbUrl}
          alt={wish.title}
          decoding="async"
          // eager === true ONLY for the first card on /wish — that's
          // the LCP candidate, blanket-lazy was delaying paint by 1
          // round-trip. fetchPriority="high" tells the browser to
          // hoist this image above other lazy candidates competing
          // for bandwidth on cold load.
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : undefined}
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
  onToggleVote:  () => void
}) {
  // 「投票按下後的 pop 動畫」獨立 state — 點擊瞬間就觸發,不等
  // mutation,因為視覺回饋必須在 100ms 內出現才有感。onAnimationEnd
  // 自動 cleanup。
  const [pulsing, setPulsing] = useState(false)

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    // demo 模式只是開 sign-in modal,沒實際投票 — 跳過 celebration
    // 以免「投了沒效果但有動畫」的錯覺。
    if (!isPreviewOnly) {
      haptic('light')
      setPulsing(true)
    }
    onToggleVote()
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
 *  totalVotes is passed separately so the +N math reflects the source
 *  of truth (`wish.votes.length`) even when some voters were dropped
 *  upstream (e.g. uid not in current members). */
function VoterStack({ voters, totalVotes }: { voters: TripMember[]; totalVotes: number }) {
  if (voters.length === 0) return null
  const shown    = voters.slice(0, MAX_AVATARS)
  const overflow = totalVotes - shown.length
  return (
    // `isolation: isolate` 建立獨立的 stacking context,把 chip 的
    // mount/unmount 鎖在這個 subtree 內。配合 AVATAR_LAYER_STYLE 上的
    // translateZ(0),為 iOS Safari PWA 修正取消投票後 voter chip
    // 殘影空心圓的 bug。
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
 *  `<a target="_blank">` (not `<button>` + window.open) for two
 *  iOS-PWA-specific reasons:
 *  1. In iOS standalone mode, `window.open(url, '_blank')` navigates the
 *     PWA's own view — when the user returns from Maps the PWA looks
 *     stuck mid-navigation. `<a target="_blank">` triggers Safari's
 *     external-link handler instead.
 *  2. iOS Universal Links route google.com/maps anchor clicks straight
 *     into the native Maps app when installed, without bouncing through
 *     Safari at all — better deep-link UX. */
function LinkChip({ url, hasAddress }: { url: string; hasAddress: boolean }) {
  // When `address` is set, the dedicated map chip already covers the
  // map role — collapse this to plain サイト so both chips don't claim
  // 地図.
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

/** Address-driven map chip. */
function MapChip({ query }: { query: string }) {
  const href = mapsSearchUrl(query)
  if (!href) return null
  return <ActionChip href={href} icon={Map} label="地図" ariaLabel="地図で開く" />
}

// React Compiler auto-memoises — no manual React.memo needed.
export default WishCard
