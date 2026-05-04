// src/features/wish/components/WishCard.tsx
// One row in the Wish list. Shows category emoji, title, optional
// description preview, optional cover thumbnail, and the heart vote
// button on the right with vote count. Tapping the body opens the form
// modal (edit for proposer, read for others).
import { memo } from 'react'
import { Heart, ExternalLink } from 'lucide-react'
import type { Wish } from '@/types'

const CATEGORY_EMOJI: Record<Wish['category'], string> = {
  place: '🗺️',
  food:  '🍜',
}

interface Props {
  wish:        Wish
  /** Has the current user voted? Drives the heart fill state. */
  isVoted:     boolean
  /** True in demo mode — visually dim the heart so users sense it's
   *  "not real yet", but the click still fires so the parent can
   *  surface the sign-in prompt. (Previously this disabled the button
   *  entirely, which swallowed the click and gave the user no feedback
   *  at all — a UX dead end.) */
  isPreviewOnly: boolean
  onTap:       () => void
  onToggleVote: () => void
}

function WishCard({
  wish, isVoted, isPreviewOnly, onTap, onToggleVote,
}: Props) {
  const voteCount = wish.votes.length

  return (
    <div className="flex items-stretch gap-2 bg-surface border border-border rounded-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.04)] overflow-hidden">
      {/* Body — tappable for edit/read */}
      <button
        onClick={onTap}
        className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left bg-transparent border-none cursor-pointer hover:bg-app transition-colors"
      >
        {wish.image ? (
          <img
            src={wish.image.thumbUrl}
            alt=""
            decoding="async"
            className="w-12 h-12 rounded-xl shrink-0 object-cover bg-tile pointer-events-none"
            draggable={false}
          />
        ) : (
          <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-[22px] bg-tile border border-black/5 pointer-events-none">
            {CATEGORY_EMOJI[wish.category]}
          </div>
        )}
        <div className="flex-1 min-w-0 pointer-events-none">
          <div className="flex items-center gap-1.5">
            <span className="text-[13.5px] font-bold text-ink truncate">
              {wish.title}
            </span>
            {wish.link && (
              <ExternalLink size={11} strokeWidth={2} className="shrink-0 text-muted" />
            )}
          </div>
          {wish.description && (
            <div className="text-[11px] text-muted mt-0.5 truncate">
              {wish.description}
            </div>
          )}
        </div>
      </button>

      {/* Vote button — separate so tapping it doesn't open the modal.
          Click always fires; demo gating happens in the parent handler so
          users get the sign-in prompt instead of an inert tap. */}
      <button
        onClick={onToggleVote}
        aria-label={isVoted ? '投票を取り消す' : '投票する'}
        aria-pressed={isVoted}
        className={[
          'shrink-0 flex flex-col items-center justify-center w-14 border-l border-border cursor-pointer transition-all bg-transparent hover:bg-app active:scale-[0.97]',
          isPreviewOnly ? 'opacity-60' : 'opacity-100',
        ].join(' ')}
      >
        <Heart
          size={20}
          strokeWidth={2}
          className={isVoted ? 'text-[#E04B5E]' : 'text-muted'}
          fill={isVoted ? '#E04B5E' : 'none'}
        />
        <span className={[
          'text-[11px] font-bold mt-0.5 tabular-nums',
          isVoted ? 'text-[#E04B5E]' : 'text-muted',
        ].join(' ')}>
          {voteCount}
        </span>
      </button>
    </div>
  )
}

// Memoised with a custom comparator that ignores the inline callback
// props (`onTap`, `onToggleVote`) — those have fresh identity every
// parent render, so the default Object.is would never skip. The data
// props (wish, isVoted, isPreviewOnly) are what actually drive the
// rendered output, and the wish reference comes from a TanStack Query
// cache so unchanged rows have stable identity.
export default memo(WishCard, (prev, next) => (
  prev.wish === next.wish &&
  prev.isVoted === next.isVoted &&
  prev.isPreviewOnly === next.isPreviewOnly
))
