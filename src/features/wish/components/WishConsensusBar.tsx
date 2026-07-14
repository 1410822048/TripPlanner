// src/features/wish/components/WishConsensusBar.tsx
// Accessible visualisation of approval-vote consensus. Shared by the list row
// and detail sheet so loading/member-count edge cases stay identical.
import type { Consensus } from '../utils'

interface Props {
  consensus: Consensus
  size:      'sm' | 'lg'
  delay?:    number
}

export default function WishConsensusBar({ consensus, size, delay = 0 }: Props) {
  const lg       = size === 'lg'
  const trackCls = ['flex-1 rounded-full bg-app overflow-hidden', lg ? 'h-2' : 'h-1.5'].join(' ')
  const labelCls = ['font-bold text-ink tabular-nums shrink-0', lg ? 'text-[13px]' : 'text-[12px]'].join(' ')

  if (!consensus.ready) {
    return (
      <div className="flex items-center gap-3 min-w-0">
        <div
          role="progressbar"
          aria-label="投票人數"
          aria-valuetext={`${consensus.votes} 票（正在確認成員人數）`}
          className={trackCls}
        />
        <span className={labelCls}>
          {consensus.votes}<span className="text-muted font-medium"> 票</span>
        </span>
      </div>
    )
  }

  const { votes, memberCount, percent } = consensus
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        role="progressbar"
        aria-label="投票人數"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${memberCount}人中${votes}人`}
        className={trackCls}
      >
        <div
          className="h-full rounded-full bg-rose origin-left transition-[width] duration-500 ease-out animate-wish-bar"
          style={{ width: `${percent}%`, animationDelay: `${delay}ms` }}
        />
      </div>
      <span className={labelCls}>
        {votes}<span className="text-muted font-medium"> 票</span>
        <span className="text-muted font-medium"> ({percent}%)</span>
      </span>
    </div>
  )
}
