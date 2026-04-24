// src/features/account/components/StackedPreviews.tsx
// Two decorative "pile" previews used inside マイページ's FeatureCard tiles:
//   - StackedEmojiPreview: 3 overlapping emoji tiles (for the lodging card).
//   - StackedAvatarPreview: overlapping member avatars (+N overflow chip).
// Both are purely visual; no click handlers of their own.
import type { TripMember } from '@/features/schedule/types'

/**
 * Three-layer stacked emoji tiles — reminiscent of a photo pile. Uses
 * rotation + offset to build a depth effect without real imagery. Caller
 * provides up to 3 emoji; extras are ignored, shorter arrays render fewer
 * tiles. Order: index 0 sits on top.
 */
export function StackedEmojiPreview({ emojis }: { emojis: readonly string[] }) {
  const slots: Array<{ emoji: string; rotate: string; translate: string; z: number }> = []
  if (emojis[2]) slots.push({ emoji: emojis[2], rotate: 'rotate-[7deg]',  translate: 'translate-x-3.5 translate-y-1.5', z: 1 })
  if (emojis[1]) slots.push({ emoji: emojis[1], rotate: '-rotate-[4deg]', translate: 'translate-x-1.5 -translate-y-0.5', z: 2 })
  if (emojis[0]) slots.push({ emoji: emojis[0], rotate: 'rotate-[2deg]',  translate: '-translate-x-1 translate-y-0.5',  z: 3 })

  return (
    <div className="relative h-full">
      {slots.map((s, i) => (
        <div
          key={i}
          className={[
            'absolute inset-0 flex items-center justify-center',
            'transform transition-transform',
            s.rotate,
            s.translate,
          ].join(' ')}
          style={{ zIndex: s.z }}
        >
          <div className="w-14 h-14 rounded-2xl bg-tile flex items-center justify-center text-[26px] shadow-[0_2px_8px_rgba(0,0,0,0.1)] border border-black/5">
            {s.emoji}
          </div>
        </div>
      ))}
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
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex">{nodes}</div>
    </div>
  )
}
