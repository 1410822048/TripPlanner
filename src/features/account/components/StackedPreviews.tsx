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

interface EmojiSlot {
  emoji:  string
  rotate: number          // degrees
  tx:     number          // px — offset from the stacked centre
  ty:     number          // px
  z:      number
}

export function StackedEmojiPreview({ emojis }: { emojis: readonly string[] }) {
  const tiles: EmojiSlot[] = []
  // Order matters: first item in array sits leftmost in flex flow; later
  // items pile on top via -56px margin. zIndex decides visual layer.
  if (emojis[2]) tiles.push({ emoji: emojis[2], rotate:  7, tx:  14, ty:  6, z: 1 })
  if (emojis[1]) tiles.push({ emoji: emojis[1], rotate: -4, tx:   6, ty: -2, z: 2 })
  if (emojis[0]) tiles.push({ emoji: emojis[0], rotate:  2, tx:  -4, ty:  2, z: 3 })

  return (
    <div
      className="flex items-center justify-center"
      style={{ height: '100%', minHeight: '72px' }}
    >
      <div className="flex">
        {tiles.map((t, i) => (
          <div
            key={i}
            className="w-14 h-14 rounded-2xl bg-tile flex items-center justify-center text-[24px] leading-none shadow-[0_2px_8px_rgba(0,0,0,0.1)] border border-black/5"
            style={{
              // -56px = a full tile width; subsequent tiles pile completely
              // on top of the first, so all three share the same flex slot.
              marginLeft: i === 0 ? 0 : '-56px',
              zIndex:     t.z,
              transform:  `translate(${t.tx}px, ${t.ty}px) rotate(${t.rotate}deg)`,
            }}
          >
            {t.emoji}
          </div>
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
    <div
      key={c.id}
      className="w-12 h-12 rounded-full flex items-center justify-center text-[14px] font-bold border-2 border-surface shadow-[0_2px_6px_rgba(0,0,0,0.1)]"
      style={{
        background: c.bg,
        color: c.color,
        marginLeft: i === 0 ? 0 : '-14px',
        zIndex: chips.length - i,
      }}
    >
      {c.label}
    </div>
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
