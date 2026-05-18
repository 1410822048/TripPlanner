// src/features/account/components/StackedPreviews.tsx
// Two decorative "pile" previews used inside マイページ's FeatureCard tiles:
//   - StackedEmojiPreview: 3 overlapping emoji tiles (for the lodging card).
//   - StackedAvatarPreview: overlapping member avatars (+N overflow chip).
// Both are purely visual; no click handlers of their own.
//
// iOS Safari note: an earlier version used `absolute inset-0` inside an
// `h-full` container. iOS resolves `h-full` to 0 inside `flex-1 min-h-0`
// grandchildren, which collapsed the stack into the top-left corner. The
// rewrite below avoids `absolute` entirely and uses pure flex flow:
//   - Each tile is a normal flex item (width counts toward layout).
//   - Subsequent tiles overlap the first via `marginLeft: -56px` (a full
//     tile width), so they share the same flex position.
//   - Per-tile `transform` adds the small rotation + offset that gives
//     the photo-pile look without affecting layout.
//   - Outer wrapper has `minHeight` so even if `height: 100%` resolves to 0
//     (iOS quirk in deep flex chains) the centring still has room to work.
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'

// Stack-tile geometry shared by the emoji + image variants. Geometry
// is keyed by *visual position in the deck* (back / middle / front),
// not by source-array index — that lets a 1- or 2-item deck collapse
// gracefully (single tile renders as the front, two tiles as front +
// middle, etc.) instead of leaving holes in the stack.
interface StackSlot {
  rotate: number          // degrees
  tx:     number          // px — offset from the stacked centre
  ty:     number          // px
  z:      number
}
const STACK_BACK:   StackSlot = { rotate:  7, tx:  14, ty:  6, z: 1 }
const STACK_MIDDLE: StackSlot = { rotate: -4, tx:   6, ty: -2, z: 2 }
const STACK_FRONT:  StackSlot = { rotate:  2, tx:  -4, ty:  2, z: 3 }

const STACK_OUTER_CLASS = 'flex items-center justify-center'
const STACK_OUTER_STYLE: React.CSSProperties = { height: '100%', minHeight: '72px' }
const TILE_BASE_CLASS  = 'w-14 h-14 rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.1)] border border-black/5'

interface StackedTile<T> {
  content: T
  slot:    StackSlot
}

/**
 * Build the back→front render order. Source array's first entry is
 * the *primary* (visually front-most); we render back→front in flex
 * flow with -56px marginLeft so they pile into a single slot.
 */
function buildStack<T>(items: readonly (T | undefined)[]): StackedTile<T>[] {
  const filtered = items.filter((x): x is T => x !== undefined && x !== null && x !== '')
  const tiles: StackedTile<T>[] = []
  // 3 → back/middle/front, 2 → middle/front, 1 → front. Always fill
  // the front slot last so the deck looks intentional at any count.
  if (filtered.length >= 3 && filtered[2] !== undefined) tiles.push({ content: filtered[2], slot: STACK_BACK   })
  if (filtered.length >= 2 && filtered[1] !== undefined) tiles.push({ content: filtered[1], slot: STACK_MIDDLE })
  if (filtered.length >= 1 && filtered[0] !== undefined) tiles.push({ content: filtered[0], slot: STACK_FRONT  })
  return tiles
}

export function StackedEmojiPreview({ emojis }: { emojis: readonly string[] }) {
  const tiles = buildStack(emojis)
  return (
    <div className={STACK_OUTER_CLASS} style={STACK_OUTER_STYLE}>
      <div className="flex">
        {tiles.map(({ content, slot }, i) => (
          <div
            key={i}
            className={`${TILE_BASE_CLASS} bg-tile flex items-center justify-center text-[24px] leading-none`}
            style={{
              // -56px = a full tile width; subsequent tiles pile completely
              // on top of the first, so all three share the same flex slot.
              marginLeft: i === 0 ? 0 : '-56px',
              zIndex:     slot.z,
              transform:  `translate(${slot.tx}px, ${slot.ty}px) rotate(${slot.rotate}deg)`,
            }}
          >
            {content}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Image-tile variant of the stacked deck. Same geometry as
 * StackedEmojiPreview so the two are visually interchangeable —
 * AccountPage swaps from emoji to image when the user has at least
 * one hotel booking with a thumbnail.
 *
 * Uses CSS `background-image` rather than `<img>`:
 *   - Decorative only, so no alt-text semantics required.
 *   - On load failure the tile's `bg-tile` colour shows through —
 *     no broken-image icon, no layout shift, no extra state to track.
 *   - `bg-cover` + `bg-center` crops landscape / portrait booking
 *     attachments cleanly into the 56×56 tile without distortion.
 */
export function StackedImagePreview({ urls }: { urls: readonly string[] }) {
  const tiles = buildStack(urls)
  return (
    <div className={STACK_OUTER_CLASS} style={STACK_OUTER_STYLE}>
      <div className="flex">
        {tiles.map(({ content, slot }, i) => (
          <div
            key={i}
            className={`${TILE_BASE_CLASS} bg-tile bg-cover bg-center`}
            style={{
              backgroundImage: `url(${content})`,
              marginLeft:      i === 0 ? 0 : '-56px',
              zIndex:          slot.z,
              transform:       `translate(${slot.tx}px, ${slot.ty}px) rotate(${slot.rotate}deg)`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Stacked circular avatar chips using the shared member palette. Up to 3
 * visible; when `extra > 0` we render a "+N" chip in the trailing slot so
 * the card communicates "there are more beyond these".
 */
export function StackedAvatarPreview({ chips, extra }: { chips: TripMember[]; extra: number }) {
  // Overlap from right to left to match the stacked-avatars pattern used
  // on the trip card — first chip is visually on top (front-most).
  const nodes = chips.slice(0, 3).map((c, i) => (
    <MemberAvatar
      key={c.id}
      member={c}
      size={48}
      className="text-[14px] border-2 border-surface shadow-[0_2px_6px_rgba(0,0,0,0.1)]"
      style={{
        marginLeft: i === 0 ? 0 : '-14px',
        zIndex: chips.length - i,
      }}
    />
  ))
  if (extra > 0) {
    nodes.push(
      <div
        key="extra"
        className="w-12 h-12 rounded-full bg-app text-muted border-2 border-surface shadow-[0_2px_6px_rgba(0,0,0,0.06)] flex items-center justify-center text-[12px] font-bold"
        style={{ marginLeft: nodes.length === 0 ? 0 : '-14px', zIndex: 0 }}
      >
        +{extra}
      </div>,
    )
  }
  // Same `height: 100% + minHeight` fallback as the emoji preview — keeps
  // vertical centring working even when iOS computes the chain's h-full as 0.
  return (
    <div
      className="flex items-center justify-center"
      style={{ height: '100%', minHeight: '60px' }}
    >
      <div className="flex">{nodes}</div>
    </div>
  )
}
