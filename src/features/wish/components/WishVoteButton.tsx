// src/features/wish/components/WishVoteButton.tsx
// Shared vote CTA for the leaderboard row and the detail sheet. Keeping the
// haptic + heart-pop interaction in one component prevents the two surfaces
// from drifting.
import { useState } from 'react'
import { Heart } from 'lucide-react'
import { haptic } from '@/utils/haptics'
import { theme } from '@/theme'

interface Props {
  isVoted:       boolean
  isPreviewOnly: boolean
  disabled:      boolean
  onToggleVote:  () => void
  variant:       'compact' | 'pill' | 'wide'
}

export default function WishVoteButton({
  isVoted, isPreviewOnly, disabled, onToggleVote, variant,
}: Props) {
  const [pulsing, setPulsing] = useState(false)

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (disabled) return
    if (!isPreviewOnly) { haptic('light'); setPulsing(true) }
    onToggleVote()
  }

  const tone = isVoted
    ? 'border-rose text-rose'
    : 'border-border text-muted hover:bg-app'
  const compact = variant === 'compact'
  const wide = variant === 'wide'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={isVoted ? '投票を取り消す' : '投票する'}
      aria-pressed={isVoted}
      className={[
        'inline-flex items-center justify-center gap-1 rounded-full border bg-surface cursor-pointer',
        'transition-all active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-55',
        tone,
        isPreviewOnly ? 'opacity-60' : '',
        compact ? 'w-7 h-7' : wide ? 'h-11 px-4 flex-1' : 'h-7 px-2.5',
      ].join(' ')}
    >
      <span
        className={pulsing ? 'animate-heart-pop inline-flex' : 'inline-flex'}
        onAnimationEnd={() => setPulsing(false)}
      >
        <Heart
          size={wide ? 15 : 13}
          strokeWidth={2.2}
          className={isVoted ? 'text-rose' : 'text-muted'}
          fill={isVoted ? theme.rose : 'none'}
        />
      </span>
      {!compact && (
        <span className={wide ? 'text-[13px] font-black' : 'text-[11px] font-bold'}>
          {isVoted ? '投票済' : '投票'}
        </span>
      )}
    </button>
  )
}
