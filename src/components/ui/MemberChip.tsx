// src/components/ui/MemberChip.tsx
// Selectable chip showing a member's avatar + label. Used wherever a
// form needs the user to pick one or many trip members:
//   - paidBy picker on expense form (single-select, size='md')
//   - item-assignee chip strip on by-item split mode (multi-select,
//     size='sm', within a card)
//
// Two sizes encode visual hierarchy:
//   - md: primary form decision, transparent background, prominent text
//   - sm: tertiary within a row, app-coloured background, muted text
//
// Future callers needing a different combination (e.g. sm + primary)
// can add a `variant` prop — kept tight to the two real call sites
// for now to avoid premature abstraction.
import type { TripMember } from '@/features/trips/types'

interface Props {
  member:   TripMember
  active:   boolean
  onClick?: () => void
  size?:    'sm' | 'md'
  disabled?: boolean
}

const SIZES = {
  sm: {
    btn:    'gap-1 pl-0.5 pr-2 py-0.5 text-[11px]',
    avatar: 'w-[18px] h-[18px] text-[9px]',
    // Item-assignee chips sit inside a card → tint the inactive bg so
    // they read as "interactive within container" rather than ghosted.
    inactive: 'bg-app text-muted',
  },
  md: {
    btn:    'gap-1.5 pl-1 pr-2.5 py-1 text-[12px]',
    avatar: 'w-[22px] h-[22px] text-[10px]',
    inactive: 'bg-transparent text-ink',
  },
} as const

export default function MemberChip({ member, active, onClick, size = 'md', disabled }: Props) {
  const s = SIZES[size]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex items-center rounded-card cursor-pointer transition-all border-[1.5px] font-normal',
        s.btn,
        active
          ? 'border-accent bg-accent text-white font-semibold'
          : `border-border ${s.inactive} hover:border-muted`,
      ].join(' ')}
    >
      <span
        className={`${s.avatar} rounded-full flex items-center justify-center font-bold shrink-0`}
        style={{ background: member.bg, color: member.color }}
      >
        {member.label}
      </span>
      {member.label}
    </button>
  )
}
