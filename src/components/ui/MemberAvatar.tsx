// src/components/ui/MemberAvatar.tsx
// Read-only circular avatar. Shows the member's Google / OAuth profile
// photo when available (avatarUrl), falls back to a coloured circle
// with the first grapheme of displayName. Used for display-only
// contexts everywhere members are listed: settlement rows, voter stack,
// members modal, trip header card, and compact form allocations.
//
// `size` is a raw pixel diameter so callers spec exactly what they
// need (typically 18-40px range). Font size auto-scales to 0.42× the
// diameter — readable across the range without per-call tuning.
//
// `className` / `style` props let callers layer on stacking offsets
// (negative marginLeft for overlapping avatar groups), borders,
// shadows, or zIndex without reinventing the img+fallback logic.
//
// `referrerPolicy="no-referrer"` is required for Google profile URLs
// (lh3.googleusercontent.com) — they 403 on requests carrying our
// origin as Referer. onError flips to the label fallback so a 404 /
// CORS reject doesn't leave a broken-image icon in the UI.
import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { TripMember } from '@/features/trips/types'
import { crispAvatarUrl } from '@/utils/avatarUrl'

interface Props {
  member:     TripMember
  /** Diameter in pixels. */
  size:       number
  /** Extra classes appended to the wrapper (e.g. border, shadow). */
  className?: string
  /** Extra inline style merged onto the wrapper (e.g. marginLeft for
   *  stacked overlap, zIndex, AVATAR_LAYER_STYLE transforms). */
  style?:     CSSProperties
}

export default function MemberAvatar({ member, size, className, style }: Props) {
  const [imgFailed, setImgFailed] = useState(false)
  const showImg = !!member.avatarUrl && !imgFailed

  return (
    <span
      className={[
        'rounded-full flex items-center justify-center font-bold shrink-0 overflow-hidden',
        className ?? '',
      ].filter(Boolean).join(' ')}
      style={{
        width:    size,
        height:   size,
        background: member.bg,
        color:      member.color,
        fontSize:   size * 0.42,
        ...style,
      }}
    >
      {showImg ? (
        <img
          src={crispAvatarUrl(member.avatarUrl, size)}
          alt=""
          referrerPolicy="no-referrer"
          className="w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        member.label
      )}
    </span>
  )
}
