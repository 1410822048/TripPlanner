// src/components/ui/ActionChip.tsx
// Pill-shaped anchor chip for opening external resources (maps,
// official sites, ticket pages). Used by WishCard's link / address
// chips and TimelineCard's location chip — same visual language so
// users learn one affordance.
//
// Anchor (not button + window.open) for two iOS-PWA-specific reasons:
//   1. In standalone mode `window.open` navigates the PWA's own view —
//      after returning from the external app the PWA looks stuck
//      mid-navigation. `<a target="_blank">` triggers Safari's external
//      handler and leaves our view alone.
//   2. iOS Universal Links route google.com/maps anchor clicks straight
//      into the native Maps app when installed.
//
// stopPropagation on click + pointerdown so the chip works inside a
// swipeable row / tap-to-edit card without arming the outer gesture.
import type { LucideIcon } from 'lucide-react'

interface Props {
  href:      string
  icon:      LucideIcon
  label:     string
  ariaLabel: string
}

export default function ActionChip({ href, icon: Icon, label, ariaLabel }: Props) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      aria-label={ariaLabel}
      className="flex items-center gap-1 h-8 px-2.5 rounded-full border border-border bg-surface text-muted hover:text-ink hover:bg-app cursor-pointer transition-colors no-underline"
    >
      <Icon size={13} strokeWidth={2} />
      <span className="text-[11px] font-semibold tracking-[0.04em]">{label}</span>
    </a>
  )
}
